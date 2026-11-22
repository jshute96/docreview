#!/usr/bin/env -S npx tsx --env-file=.env
// Probe the Docs API suggestion-thread support (Document.suggestions[],
// commentsViewMode, acceptSuggestion / rejectSuggestion / addCommentReply) against
// a real doc, using the OAuth token stored for a docreview user.
//
// This is a research tool, not app code: it answers "does the API behave the way
// the reference docs say?" before we build on it. It talks REST directly through
// the app's OAuth client so it doesn't depend on the @googleapis/docs version.
//
// Text content (suggestion summaries, post bodies, author names) is redacted
// unless --show-text is given. Nothing is written to the app's log files.
import { writeFileSync } from "fs";
import { prisma } from "../src/lib/prisma";
import { getDriveClient } from "../src/lib/google-drive";
import { isDiscoId } from "../src/lib/disco-id";

const USAGE = `Probe Docs API suggestion threads.

Usage:
  npx tsx --env-file=.env scripts/probe-suggestion-threads.ts read   <docId> [flags]
  npx tsx --env-file=.env scripts/probe-suggestion-threads.ts reply  <docId> <suggestionId> <text> --yes
  npx tsx --env-file=.env scripts/probe-suggestion-threads.ts accept <docId> <suggestionId> --yes
  npx tsx --env-file=.env scripts/probe-suggestion-threads.ts reject <docId> <suggestionId> --yes

  read     Fetch the doc with COMMENTS_VIEW_MODE_INCLUDED and report what the new
           suggestions[] / comments[] fields contain, cross-checked against the
           inline suggest.* IDs in the body and against Drive comments.list/get.
  reply    addCommentReply on a suggestion thread, then re-read the thread.
  accept   acceptSuggestion, print suggestionResponses, then re-read the thread.
  reject   rejectSuggestion, same.

Flags:
  --user <email>  docreview user whose Google token to use (default: the only one)
  --show-text     print summaries / post content / author names (redacted by default)
  --dump <file>   write the raw documents.get response JSON to <file>
  --yes           required for write commands (they modify the real doc)
`;

const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

type Auth = Awaited<ReturnType<typeof getDriveClient>>;

interface PostAuthor { displayName?: string; me?: boolean; anonymous?: boolean; user?: string }
interface Post {
  postId?: string; author?: PostAuthor; content?: string; contentHtml?: string;
  createTime?: string; updateTime?: string; deleted?: boolean;
  suggestionAction?: string; commentAction?: string;
}
interface SuggestionThread {
  suggestionId?: string; status?: string; summaryText?: string; summaryHtml?: string;
  headPost?: Post; replies?: Post[];
}
interface CommentThread {
  commentId?: string; anchorId?: string; status?: string; plainTextQuote?: string;
  headPost?: Post; replies?: Post[];
}
interface DocResponse {
  suggestions?: SuggestionThread[];
  comments?: CommentThread[];
  tabs?: unknown[];
  commentsViewMode?: string;
  suggestionsViewMode?: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const positional = args.filter((a, i) => !a.startsWith("--") && !["--user", "--dump"].includes(args[i - 1]));
const SHOW_TEXT = flag("--show-text");

function redact(s: string | undefined | null): string {
  if (s == null) return "∅";
  if (SHOW_TEXT) return JSON.stringify(s.length > 120 ? s.slice(0, 120) + "…" : s);
  return `<${s.length} chars>`;
}

function idFormat(id: string | undefined): string {
  if (!id) return "∅";
  if (id.startsWith("doco.")) return "doco";
  if (/^AAA[A-Z]/.test(id)) return "AAA*";
  if (id.startsWith("suggest.")) return "suggest.*";
  if (id.startsWith("kix.")) return "kix.*";
  return "other";
}

async function api<T>(auth: Auth, method: "GET" | "POST", url: string, data?: unknown): Promise<T> {
  const t0 = Date.now();
  try {
    const res = await auth.request<T>({ method, url, data });
    process.stderr.write(`  ${method} ${url.split("?")[0]} → ${res.status} (${Date.now() - t0}ms)\n`);
    return res.data;
  } catch (err) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    process.stderr.write(`  ${method} ${url.split("?")[0]} → FAILED ${e.response?.status ?? ""} (${Date.now() - t0}ms)\n`);
    process.stderr.write(`  ${JSON.stringify(e.response?.data ?? e.message, null, 2)}\n`);
    throw err;
  }
}

/**
 * Collect every suggestion ID referenced anywhere in the document body —
 * headers, footers, footnotes, inline objects, paragraph styles, everything —
 * by walking the whole JSON tree. Keys follow two patterns in the Docs schema:
 * `suggestedInsertionIds` / `suggestedDeletionIds` (arrays, sometimes a single
 * `suggestedInsertionId`), and `suggested*Changes` maps keyed by suggestion ID.
 */
function collectInlineSuggestionIds(node: unknown, out = new Map<string, Set<string>>(), path = ""): Map<string, Set<string>> {
  const add = (id: string, where: string) => {
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(where);
  };
  if (Array.isArray(node)) {
    node.forEach((n) => collectInlineSuggestionIds(n, out, path));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // Coarse location: which top-level container (body/headers/footers/footnotes/...) it was in.
      const where = path || k;
      if (/^suggested\w*Ids?$/.test(k)) {
        for (const id of Array.isArray(v) ? v : [v]) if (typeof id === "string") add(id, `${where}:${k}`);
      } else if (/^suggested\w*Changes$/.test(k) && v && typeof v === "object") {
        for (const id of Object.keys(v)) add(id, `${where}:${k}`);
      }
      const nextPath = ["body", "headers", "footers", "footnotes", "inlineObjects", "positionedObjects", "documentStyle", "namedStyles", "lists"].includes(k) ? k : path;
      collectInlineSuggestionIds(v, out, nextPath);
    }
  }
  return out;
}

async function fetchDoc(auth: Auth, docId: string): Promise<DocResponse> {
  const qs = new URLSearchParams({
    includeTabsContent: "true",
    suggestionsViewMode: "SUGGESTIONS_INLINE",
    commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
  });
  return api<DocResponse>(auth, "GET", `${DOCS}/${docId}?${qs}`);
}

interface DriveComment { id: string; anchor?: string; resolved?: boolean; deleted?: boolean; replies?: { id: string }[] }

async function listDriveComments(auth: Auth, docId: string): Promise<DriveComment[]> {
  const all: DriveComment[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({
      fields: "nextPageToken,comments(id,anchor,resolved,deleted,replies(id))",
      includeDeleted: "true",
      pageSize: "100",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await api<{ comments?: DriveComment[]; nextPageToken?: string }>(auth, "GET", `${DRIVE}/${docId}/comments?${qs}`);
    all.push(...(res.comments ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return all;
}

function describePost(p: Post | undefined, indent: string): string {
  if (!p) return `${indent}∅`;
  const who = p.author?.me ? "me" : SHOW_TEXT ? (p.author?.displayName ?? "?") : "other";
  const act = [p.suggestionAction, p.commentAction].filter((a) => a && !a.startsWith("NO_") && !a.endsWith("UNSPECIFIED")).join(",");
  return `${indent}post ${p.postId} [${idFormat(p.postId)}${isDiscoId(p.postId ?? "") ? ", isDiscoId" : ""}] by ${who} ` +
    `created ${p.createTime ?? "∅"} updated ${p.updateTime ?? "∅"}${p.deleted ? " DELETED" : ""}${act ? ` action=${act}` : ""} ` +
    `content ${redact(p.content)}`;
}

function printThread(t: SuggestionThread, indent = "  ") {
  console.log(`${indent}${t.suggestionId} status=${t.status} summary=${redact(t.summaryText)} summaryHtml=${t.summaryHtml ? `<${t.summaryHtml.length} chars>` : "∅"}`);
  console.log(describePost(t.headPost, indent + "  head "));
  for (const r of t.replies ?? []) console.log(describePost(r, indent + "  reply"));
}

async function cmdRead(auth: Auth, userId: string, docId: string) {
  const doc = await fetchDoc(auth, docId);
  const dumpPath = flagValue("--dump");
  if (dumpPath) {
    writeFileSync(dumpPath, JSON.stringify(doc, null, 2));
    console.log(`Raw response written to ${dumpPath}`);
  }
  console.log(`\nApplied modes: comments=${doc.commentsViewMode} suggestions=${doc.suggestionsViewMode}`);

  const threads = doc.suggestions ?? [];
  const comments = doc.comments ?? [];
  const byStatus: Record<string, number> = {};
  for (const t of threads) byStatus[t.status ?? "∅"] = (byStatus[t.status ?? "∅"] ?? 0) + 1;
  console.log(`\n=== suggestions[]: ${threads.length} threads ${JSON.stringify(byStatus)}`);
  for (const t of threads) printThread(t);

  const cStatus: Record<string, number> = {};
  for (const c of comments) cStatus[c.status ?? "∅"] = (cStatus[c.status ?? "∅"] ?? 0) + 1;
  console.log(`\n=== comments[]: ${comments.length} threads ${JSON.stringify(cStatus)}`);
  for (const c of comments) {
    console.log(`  ${c.commentId} [${idFormat(c.commentId)}] status=${c.status} anchor=${c.anchorId} replies=${c.replies?.length ?? 0} head.postId=${c.headPost?.postId}`);
  }

  // --- Cross-check 1: suggestions[] vs inline suggest.* IDs in the body ---
  const inline = collectInlineSuggestionIds(doc.tabs);
  const threadIds = new Set(threads.map((t) => t.suggestionId!).filter(Boolean));
  const openThreadIds = new Set(threads.filter((t) => t.status === "OPEN").map((t) => t.suggestionId!));
  console.log(`\n=== Cross-check: inline suggestion IDs (${inline.size}) vs suggestions[] (${threadIds.size})`);
  for (const [id, where] of inline) {
    const t = threads.find((x) => x.suggestionId === id);
    console.log(`  ${id}  inline@{${[...where].join(", ")}}  thread=${t ? t.status : "MISSING"}`);
  }
  for (const t of threads) {
    if (!inline.has(t.suggestionId!)) console.log(`  ${t.suggestionId}  NOT inline  thread=${t.status}`);
  }
  const openNotInline = [...openThreadIds].filter((id) => !inline.has(id));
  const inlineNoThread = [...inline.keys()].filter((id) => !threadIds.has(id));
  console.log(`  → inline IDs with no thread: ${inlineNoThread.length}; OPEN threads not inline: ${openNotInline.length}`);

  // --- Cross-check 2: are headPost.postIds Drive comment IDs? ---
  console.log(`\n=== Cross-check: suggestion headPost.postId vs Drive comments API`);
  const driveComments = await listDriveComments(auth, docId);
  const driveIds = new Map(driveComments.map((c) => [c.id, c]));
  console.log(`  Drive comments.list returned ${driveComments.length} threads`);
  for (const t of threads) {
    const pid = t.headPost?.postId;
    if (!pid) { console.log(`  ${t.suggestionId}: no headPost.postId`); continue; }
    const listed = driveIds.get(pid);
    let getResult = listed ? "listed" : "not listed";
    if (!listed) {
      // comments.list is known to omit suggestion threads; see whether Drive
      // can still address one directly by this ID (that would let the existing
      // Drive reply path work for suggestions too).
      try {
        const c = await api<DriveComment>(auth, "GET", `${DRIVE}/${docId}/comments/${pid}?fields=id,anchor,resolved,deleted,replies(id)&includeDeleted=true`);
        getResult = `not listed, comments.get OK (resolved=${c.resolved}, replies=${c.replies?.length ?? 0}, anchor=${redact(c.anchor)})`;
      } catch (err) {
        getResult = `not listed, comments.get FAILED ${(err as { response?: { status?: number } }).response?.status ?? ""}`;
      }
    } else {
      getResult += ` (resolved=${listed.resolved}, replies=${listed.replies?.length ?? 0})`;
    }
    const replyIdsMatch = listed?.replies
      ? (t.replies ?? []).every((r) => listed.replies!.some((dr) => dr.id === r.postId))
      : undefined;
    console.log(`  ${t.suggestionId} → ${pid}: ${getResult}${replyIdsMatch === undefined ? "" : ` replyIdsMatchDrive=${replyIdsMatch}`}`);
  }

  // --- Cross-check 3: does the docreview DB already know this disco ID? ---
  const dbDoc = await prisma.doc.findFirst({ where: { userId, googleDocId: docId }, select: { docId: true } });
  if (dbDoc) {
    const rows = await prisma.comment.findMany({
      where: { docId: dbDoc.docId, type: "SUGGESTION" },
      select: { googleSuggestionId: true, googleCommentId: true, resolved: true },
    });
    console.log(`\n=== Cross-check: docreview DB suggestion rows (${rows.length})`);
    for (const r of rows) {
      const t = threads.find((x) => x.suggestionId === r.googleSuggestionId || x.headPost?.postId === r.googleCommentId);
      const agree = t && r.googleCommentId && r.googleSuggestionId
        ? (t.suggestionId === r.googleSuggestionId && t.headPost?.postId === r.googleCommentId ? "IDs AGREE" : "IDs DISAGREE")
        : "";
      console.log(`  db sid=${r.googleSuggestionId ?? "∅"} disco=${r.googleCommentId ?? "∅"} resolved=${r.resolved} → api ${t ? `${t.suggestionId}/${t.headPost?.postId} ${t.status}` : "no match"} ${agree}`);
    }
  } else {
    console.log(`\n(doc not tracked in docreview DB — skipping DB cross-check)`);
  }
}

async function batchUpdate(auth: Auth, docId: string, request: Record<string, unknown>) {
  const res = await api<Record<string, unknown>>(auth, "POST", `${DOCS}/${docId}:batchUpdate`, { requests: [request] });
  console.log(`\nbatchUpdate response:\n${JSON.stringify({ ...res, replies: SHOW_TEXT ? res.replies : "(redacted, use --show-text)" }, null, 2)}`);
}

async function rereadThread(auth: Auth, docId: string, suggestionId: string) {
  const doc = await fetchDoc(auth, docId);
  const t = (doc.suggestions ?? []).find((x) => x.suggestionId === suggestionId);
  console.log(`\nThread after write:`);
  if (t) printThread(t);
  else console.log(`  ${suggestionId} no longer in suggestions[] (${doc.suggestions?.length ?? 0} threads remain)`);
  const inline = collectInlineSuggestionIds(doc.tabs);
  console.log(`  still inline in body: ${inline.has(suggestionId)}`);
}

async function main() {
  if (flag("--help") || positional.length < 2) {
    process.stdout.write(USAGE);
    process.exit(positional.length < 2 && !flag("--help") ? 1 : 0);
  }
  const [cmd, docId, suggestionId, ...rest] = positional;

  const email = flagValue("--user");
  const users = await prisma.user.findMany({
    where: { ...(email ? { email } : {}), accounts: { some: { provider: "google" } } },
    select: { id: true },
  });
  if (users.length !== 1) {
    throw new Error(email ? `No user with a Google account matches --user` : `${users.length} users have Google accounts; pass --user <email>`);
  }
  const auth = await getDriveClient(users[0].id);

  const isWrite = cmd !== "read";
  if (isWrite && !flag("--yes")) throw new Error(`'${cmd}' modifies the real document; re-run with --yes`);
  if (isWrite && !suggestionId) throw new Error(`'${cmd}' needs a suggestionId (suggest.xxx)`);

  switch (cmd) {
    case "read":
      await cmdRead(auth, users[0].id, docId);
      break;
    case "reply": {
      const text = rest.join(" ");
      if (!text) throw new Error("reply needs text");
      await batchUpdate(auth, docId, { addCommentReply: { suggestionId, post: { content: text } } });
      await rereadThread(auth, docId, suggestionId);
      break;
    }
    case "accept":
      await batchUpdate(auth, docId, { acceptSuggestion: { suggestionId } });
      await rereadThread(auth, docId, suggestionId);
      break;
    case "reject":
      await batchUpdate(auth, docId, { rejectSuggestion: { suggestionId } });
      await rereadThread(auth, docId, suggestionId);
      break;
    default:
      throw new Error(`Unknown command '${cmd}'\n\n${USAGE}`);
  }
}

main()
  .catch((err) => {
    process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

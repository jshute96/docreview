import { drive as createDrive } from "@googleapis/drive";
import { docs as createDocs } from "@googleapis/docs";
import { OAuth2Client } from "google-auth-library";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, OfflineModeError } from "@/lib/offline";
import { logError, logWarning, logInfo } from "@/lib/log";
import { withProgressLogging } from "./promise-utils";
import { formatDate } from "./utils";

export const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

/** Detect expired/revoked OAuth refresh token (Google returns 400 invalid_grant) */
export function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof Error && err.message?.includes("invalid_grant")) return true;
  const code = (err as { code?: number | string })?.code;
  return code === 400 && String(err).includes("invalid_grant");
}

const REAUTH_MESSAGE = "Google authorization expired. Please sign out and sign back in.";

/** If err is an invalid_grant error, return a 401 NextResponse; otherwise return null. */
export function invalidGrantResponse(err: unknown): NextResponse | null {
  if (!isInvalidGrantError(err)) return null;
  logWarning("[Auth] Google authorization expired (invalid_grant)");
  return NextResponse.json({ error: REAUTH_MESSAGE }, { status: 401 });
}

const BARE_DOC_ID_RE = /^[a-zA-Z0-9_-]{20,}$/;

export function parseGoogleDocId(url: string): string | null {
  const trimmed = url.trim();
  if (BARE_DOC_ID_RE.test(trimmed)) return trimmed;

  // Try /d/ID pattern
  const dMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dMatch?.[1]) return dMatch[1];

  // Try ?id=ID pattern (for drive.google.com/open?id=ID)
  try {
    const parsedUrl = new URL(trimmed);
    const idParam = parsedUrl.searchParams.get("id");
    if (idParam && BARE_DOC_ID_RE.test(idParam)) {
      return idParam;
    }
  } catch (err) {
    // Not a valid full URL, skip searchParam check
  }

  return null;
}

export async function getDriveClient(userId: string) {
  if (OFFLINE_MODE) throw new OfflineModeError("getDriveClient");

  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.access_token) {
    throw new Error("No Google account found for user");
  }

  const oauth2Client = new OAuth2Client(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET
  );

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  // Persist refreshed tokens back to DB
  oauth2Client.on("tokens", async (tokens) => {
    try {
      await prisma.account.update({
        where: { id: account.id },
        data: {
          access_token: tokens.access_token ?? account.access_token,
          refresh_token: tokens.refresh_token ?? account.refresh_token,
          expires_at: tokens.expiry_date
            ? Math.floor(tokens.expiry_date / 1000)
            : account.expires_at,
        },
      });
    } catch (err) {
      logError("[Auth] Failed to persist refreshed tokens:", err);
    }
  });

  return oauth2Client;
}

export function createDriveService(auth: Awaited<ReturnType<typeof getDriveClient>>) {
  return createDrive({ version: "v3", auth });
}

export interface DriveDoc {
  googleDocId: string;
  title: string;
  driveUrl: string;
  mimeType: string;
  role: "AUTHOR" | "REVIEWER";
  lastModifiedInDrive: Date | null;
  createdTimeInDrive: Date | null;
}

// Returns the subset of googleDocIds that are deleted (trashed, permanently deleted)
// and the subset that are permission-denied (403).
// Runs all files.get calls in parallel rather than sequentially.
export async function findDeletedOrDeniedDocIds(
  userId: string,
  googleDocIds: string[]
): Promise<{ trashedIds: Set<string>; deletedIds: Set<string>; permissionDeniedIds: Set<string> }> {
  if (googleDocIds.length === 0) return { trashedIds: new Set(), deletedIds: new Set(), permissionDeniedIds: new Set() };

  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });

  const results = await Promise.all(
    googleDocIds.map(async (id) => {
      const t0 = Date.now();
      try {
        const res = await drive.files.get({ fileId: id, fields: "trashed", supportsAllDrives: true });
        const trashed = res.data.trashed === true;
        logInfo(`[Drive] files.get ${id} → ${trashed ? "trashed" : "ok"} (${Date.now() - t0}ms)`);
        return { id, status: trashed ? "trashed" as const : "ok" as const };
      } catch (err: unknown) {
        const code = (err as { code?: number | string })?.code;
        if (code === 404 || code === "404") {
          logWarning(`[Drive] files.get ${id} → not found (${Date.now() - t0}ms)`);
          return { id, status: "deleted" as const };
        }
        if (code === 403 || code === "403") {
          logWarning(`[Drive] files.get ${id} → permission denied (${Date.now() - t0}ms)`);
          return { id, status: "denied" as const };
        }
        logError(`[Drive] files.get ${id} → transient error (skipping, ${Date.now() - t0}ms):`, err);
        return { id, status: "ok" as const };
      }
    })
  );

  return {
    trashedIds: new Set(results.filter((r) => r.status === "trashed").map((r) => r.id)),
    deletedIds: new Set(results.filter((r) => r.status === "deleted").map((r) => r.id)),
    permissionDeniedIds: new Set(results.filter((r) => r.status === "denied").map((r) => r.id)),
  };
}

export interface DriveComment {
  id: string;
  resolved: boolean;
  isThreadAuthor: boolean;
  isReplyAuthor: boolean;
  iResolvedIt: boolean;
  isRead: boolean;
  assignedToMe: boolean;
  mentionedMe: boolean;
  mentionedMeUnreplied: boolean;
  driveCreatedAt: Date | null;
  driveModifiedAt: Date | null;
  replyCount: number;
  replyAuthorMeFlags: boolean[];
  replyMentionedMeFlags: boolean[];
}

// Derives ownership/participation flags from a Drive comment's author and replies.
export function deriveCommentFlags(
  author: { me?: boolean | null } | undefined | null,
  replies: { action?: string | null; author?: { me?: boolean | null } | null }[]
): { isThreadAuthor: boolean; isReplyAuthor: boolean; iResolvedIt: boolean; isRead: boolean } {
  const isThreadAuthor = author?.me === true;
  const isReplyAuthor = replies.some(
    (r) => r.author?.me === true
  );
  const lastResolveReply = [...replies]
    .reverse()
    .find((r) => r.action === "resolve");
  const iResolvedIt = lastResolveReply?.author?.me === true;
  const isRead = replies.length > 0
    ? replies[replies.length - 1].author?.me === true
    : author?.me === true;
  return { isThreadAuthor, isReplyAuthor, iResolvedIt, isRead };
}

// Raw Drive API comment shape — loose type covering the superset of fields
// that fetchCommentData may request.  Used only by the parsing helpers below.
type RawDriveComment = {
  id?: string | null;
  resolved?: boolean | null;
  content?: string | null;
  htmlContent?: string | null;
  quotedFileContent?: { mimeType?: string | null; value?: string | null } | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  author?: { me?: boolean | null; displayName?: string | null } | null;
  assigneeEmailAddress?: string | null;
  mentionedEmailAddresses?: string[] | null;
  replies?: Array<{
    content?: string | null;
    htmlContent?: string | null;
    createdTime?: string | null;
    action?: string | null;
    author?: { me?: boolean | null; displayName?: string | null } | null;
    mentionedEmailAddresses?: string[] | null;
  }> | null;
};

// Parses a raw Drive comment into a DriveComment (sync metadata).
function parseDriveComment(c: RawDriveComment, emailLower?: string): DriveComment {
  const replies = c.replies ?? [];
  const flags = deriveCommentFlags(c.author, replies);

  const assignedToMe = emailLower
    ? c.assigneeEmailAddress?.toLowerCase() === emailLower
    : false;
  const mentionedMe = emailLower
    ? (c.mentionedEmailAddresses ?? []).some((e) => e.toLowerCase() === emailLower)
    : false;
  const replyAuthorMeFlags = replies.map((r) => r.author?.me === true);
  const replyMentionedMeFlags = replies.map((r) =>
    emailLower
      ? (r.mentionedEmailAddresses ?? []).some(
            (e) => e.toLowerCase() === emailLower
          )
      : false
  );

  let mentionedMeUnreplied = false;
  if (mentionedMe || replyMentionedMeFlags.some(Boolean)) {
    let lastMentionIdx = -1;
    for (let i = replyMentionedMeFlags.length - 1; i >= 0; i--) {
      if (replyMentionedMeFlags[i]) { lastMentionIdx = i; break; }
    }
    if (lastMentionIdx === -1 && mentionedMe) {
      mentionedMeUnreplied = !replyAuthorMeFlags.some(Boolean);
    } else if (lastMentionIdx >= 0) {
      const hasMyReplyAfter = replyAuthorMeFlags.slice(lastMentionIdx + 1).some(Boolean);
      mentionedMeUnreplied = !hasMyReplyAfter;
    }
  }

  const effectiveMentionedMe = assignedToMe ? false : mentionedMe;
  const effectiveReplyMentionedMeFlags = assignedToMe
    ? replyMentionedMeFlags.map(() => false)
    : replyMentionedMeFlags;

  return {
    id: c.id!,
    resolved: c.resolved === true,
    ...flags,
    assignedToMe,
    mentionedMe: effectiveMentionedMe,
    mentionedMeUnreplied: assignedToMe ? false : mentionedMeUnreplied,
    driveCreatedAt: c.createdTime ? new Date(c.createdTime) : null,
    driveModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
    replyCount: replies.length,
    replyAuthorMeFlags,
    replyMentionedMeFlags: effectiveReplyMentionedMeFlags,
  };
}

// Parses a raw Drive comment into a CommentThread (UI display).
// Returns null if the comment has no content (deleted/empty comment).
function parseCommentThread(c: RawDriveComment): CommentThread | null {
  if (c.content == null) return null;
  const replies = c.replies ?? [];

  const threadReplies: ThreadReply[] = replies.map((r) => ({
    author: r.author?.displayName ?? "Unknown",
    fromMe: r.author?.me === true,
    content: r.content ?? "",
    ...(r.htmlContent ? { htmlContent: r.htmlContent } : {}),
    createdTime: r.createdTime ?? "",
    ...(r.action === "resolve" || r.action === "reopen" ? { action: r.action } : {}),
  }));

  return {
    id: c.id!,
    author: c.author?.displayName ?? "Unknown",
    fromMe: c.author?.me === true,
    content: c.content,
    ...(c.htmlContent ? { htmlContent: c.htmlContent } : {}),
    createdTime: c.createdTime ?? "",
    ...(c.modifiedTime ? { modifiedTime: c.modifiedTime } : {}),
    resolved: c.resolved === true,
    replies: threadReplies,
    quotedFileContent: extractQuotedFileContent(c.quotedFileContent, c.id),
  };
}

/** Options for fetchCommentData — at least one of sync/threads must be true. */
export interface FetchCommentDataOptions {
  /** Return DriveComment[] for DB sync (requires sync-specific fields: assignee, mentions). */
  sync?: boolean;
  /** Return CommentThread[] for UI display (requires content, displayName, quotedFileContent). */
  threads?: boolean;
  /** User email — needed when sync is true, for assignee/mention detection. */
  userEmail?: string;
}

/** Result of fetchCommentData — fields are present based on the options passed. */
export interface CommentDataResult {
  comments?: DriveComment[];
  threads?: CommentThread[];
}

// Builds the per-comment Drive API fields string based on which outputs are
// needed. Used by both comments.list (via buildCommentListFields) and comments.get.
// sync-only: lean metadata fields. threads-only: content/display fields.
// Both: superset of all fields.
function buildCommentFields(options: FetchCommentDataOptions): string {
  const { sync, threads } = options;
  // Author fields
  const authorFields = threads ? "me, displayName" : "me";
  // Reply fields
  const replyParts = ["action", `author(${authorFields})`];
  if (threads) replyParts.push("content", "htmlContent", "createdTime");
  if (sync) replyParts.push("mentionedEmailAddresses");
  // Comment fields
  const commentParts = [
    "id", "resolved", "createdTime", "modifiedTime",
    `author(${authorFields})`,
    `replies(${replyParts.join(", ")})`,
  ];
  if (threads) commentParts.push("content", "htmlContent", "quotedFileContent(mimeType, value)");
  if (sync) commentParts.push("assigneeEmailAddress", "mentionedEmailAddresses");

  return commentParts.join(", ");
}

// Wraps per-comment fields for comments.list (adds pagination token).
function buildCommentListFields(options: FetchCommentDataOptions): string {
  return `nextPageToken, comments(${buildCommentFields(options)})`;
}

/**
 * Fetches comment data from the Drive API with only the fields needed by the
 * requested outputs. Single entry point for all comments.list calls —
 * field string is built dynamically based on which outputs are needed.
 */
export async function fetchCommentData(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  options: FetchCommentDataOptions = { threads: true },
): Promise<CommentDataResult> {
  const { sync, threads } = options;
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();
  const emailLower = options.userEmail?.toLowerCase();
  const fields = buildCommentListFields(options);

  const commentsList: DriveComment[] = [];
  const threadsList: CommentThread[] = [];
  let pageToken: string | undefined;

  // Label for logging — indicates which outputs were requested
  const mode = sync && threads ? "unified" : sync ? "sync" : "threads";

  try {
    do {
      const res = await withProgressLogging(
        drive.comments.list({
          fileId: googleDocId,
          fields,
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        }),
        `[Drive] comments.list ${googleDocId} (${mode}${pageToken ? " page" : ""})`
      );

      for (const c of res.data.comments ?? []) {
        if (!c.id) continue;
        const raw = c as RawDriveComment;
        if (sync) commentsList.push(parseDriveComment(raw, emailLower));
        if (threads) {
          const thread = parseCommentThread(raw);
          if (thread) threadsList.push(thread);
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    // When only fetching threads (UI display), gracefully return empty on
    // permission denied — the user can still see the doc, just not comments.
    // When sync is requested, let the error propagate so syncComments can
    // handle it (e.g. stamping sync time, flagging permissionDenied).
    if (err.code === 403 && threads && !sync) {
      logWarning(`[Drive] Permission denied for comments on ${googleDocId}.`);
      return { threads: [] };
    }
    throw err;
  }

  const parts: string[] = [];
  if (sync) parts.push(`${commentsList.length} comments`);
  if (threads) parts.push(`${threadsList.length} threads`);
  logInfo(`[Drive] comments.list ${googleDocId} (${mode}) → ${parts.join(", ")} (${Date.now() - t0}ms)`);

  return {
    ...(sync ? { comments: commentsList } : {}),
    ...(threads ? { threads: threadsList } : {}),
  };
}

export interface DriveSuggestion {
  id: string;
  suggestionType: "INSERT" | "DELETE" | "EDIT";
  insertedText: string;
  deletedText: string;
}

export interface SuggestionContent {
  insertedText: string;
  deletedText: string;
}

/** Result of fetchDocData — always returns all fields from a single documents.get call. */
export interface DocDataResult {
  /** Full document text (with suggestion text inlined). Null on permission error. */
  documentText: string | null;
  /** Suggestion content keyed by suggestion ID — for UI display (diffs). */
  suggestionContent: Record<string, SuggestionContent>;
  /** DriveSuggestion[] — for DB sync (type classification + content hashing). */
  suggestions: DriveSuggestion[];
}

/**
 * Fetches document data via the Docs API — a single documents.get call that
 * returns document text, suggestion content (for UI), and DriveSuggestion[]
 * (for DB sync). Single entry point for all documents.get calls.
 *
 * Uses SUGGESTIONS_INLINE so both pending insertions and deletions are visible
 * alongside the base text. This means documentText includes suggestion text —
 * anchor-text matching may give false results if a suggestion overlaps the
 * anchor region, but the consequence is only a spurious "not found" warning.
 */
export async function fetchDocData(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<DocDataResult> {
  const docs = createDocs({ version: "v1", auth });
  const t0 = Date.now();

  let res;
  try {
    res = await withProgressLogging(
      docs.documents.get({
        documentId: googleDocId,
        suggestionsViewMode: "SUGGESTIONS_INLINE",
        fields:
          "body(content(paragraph(elements(textRun(content,suggestedInsertionIds,suggestedDeletionIds)))))",
      }),
      `[Docs] documents.get ${googleDocId}`
    );
  } catch (err: any) {
    // If we have view-only access but no permission for comments/suggestions,
    // Google might fail the entire call. Retry without asking for suggestions.
    if (
      err.code === 403 &&
      err.message?.includes("permission to access the document suggestions")
    ) {
      logWarning(
        `[Docs] Permission denied for suggestions on ${googleDocId}, retrying without suggestions.`
      );
      try {
        res = await withProgressLogging(
          docs.documents.get({
            documentId: googleDocId,
            fields: "body(content(paragraph(elements(textRun(content)))))",
          }),
          `[Docs] documents.get ${googleDocId} (no suggestions)`
        );
      } catch (innerErr) {
        logError(
          `[Docs] documents.get ${googleDocId} failed even without suggestions (${
            Date.now() - t0
          }ms):`,
          innerErr
        );
        return { documentText: null, suggestionContent: {}, suggestions: [] };
      }
    } else {
      const isPermission = err.code === 403 || err.code === 404 ||
        /permission|forbidden|not found/i.test(err.message ?? "");
      if (isPermission) {
        logError(`[Docs] documents.get ${googleDocId} failed (${Date.now() - t0}ms): ${err.message ?? err}`);
      } else {
        logError(`[Docs] documents.get ${googleDocId} failed (${Date.now() - t0}ms):`, err);
      }
      return { documentText: null, suggestionContent: {}, suggestions: [] };
    }
  }

  const textParts: string[] = [];
  // Track insertion/deletion IDs via sets (for type classification) and accumulate
  // text per suggestion ID. A single suggestion may span multiple text runs.
  const insertionIds = new Set<string>();
  const deletionIds = new Set<string>();
  const insertions: Record<string, string> = {};
  const deletions: Record<string, string> = {};

  for (const el of res.data.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const run = pe.textRun;
      if (!run?.content) continue;
      textParts.push(run.content);
      const text = run.content;

      for (const id of run.suggestedInsertionIds ?? []) {
        insertionIds.add(id);
        insertions[id] = (insertions[id] ?? "") + text;
      }
      for (const id of run.suggestedDeletionIds ?? []) {
        deletionIds.add(id);
        deletions[id] = (deletions[id] ?? "") + text;
      }
    }
  }

  const documentText = textParts.join("");
  for (const id in insertions) insertions[id] = insertions[id].replace(/\n$/, "");
  for (const id in deletions) deletions[id] = deletions[id].replace(/\n$/, "");

  // Build both output formats from the same parsed data
  const allIds = new Set([...insertionIds, ...deletionIds]);

  const suggestionContent: Record<string, SuggestionContent> = {};
  const suggestions: DriveSuggestion[] = [];
  for (const id of allIds) {
    const hasInsert = insertionIds.has(id);
    const hasDelete = deletionIds.has(id);
    const insertedText = insertions[id] ?? "";
    const deletedText = deletions[id] ?? "";
    suggestionContent[id] = { insertedText, deletedText };
    suggestions.push({
      id,
      suggestionType: hasInsert && hasDelete ? "EDIT" : hasInsert ? "INSERT" : "DELETE",
      insertedText,
      deletedText,
    });
  }

  logInfo(`[Docs] documents.get ${googleDocId} (${documentText.length} chars, ${allIds.size} suggestions) (${Date.now() - t0}ms)`);
  return { documentText, suggestionContent, suggestions };
}

// A single reply within a comment thread (not the initial comment).
export interface ThreadReply {
  author: string;
  fromMe: boolean;
  content: string;
  htmlContent?: string;
  createdTime: string;
  action?: "resolve" | "reopen" | "accept" | "reject";
}

// A comment thread on a document: the initial comment plus all replies.
// The top-level author/content/createdTime are the initial comment;
// `replies` contains the subsequent responses.
export interface CommentThread {
  id: string;
  author: string;
  fromMe: boolean;
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  resolved: boolean;
  replies: ThreadReply[];
  quotedFileContent?: { mimeType: string; value: string } | null;
}

/** Map of Google comment/suggestion IDs to their thread data. */
export type ThreadMap = Record<string, CommentThread>;

/** Extract quotedFileContent from a Drive comment, filtering to displayable MIME types.
 *  Note: the Drive API truncates long quoted text (the truncation format is undocumented).
 *  Callers comparing against document text should strip trailing "..." or "…" first. */
function extractQuotedFileContent(
  qfc: { mimeType?: string | null; value?: string | null } | null | undefined,
  commentId: string | null | undefined,
): CommentThread["quotedFileContent"] {
  if (!qfc?.value) return null;
  const mime = qfc.mimeType ?? "text/plain";
  if (mime === "text/plain" || mime === "text/html") return { mimeType: mime, value: qfc.value };
  logInfo(`[Drive] Unexpected quotedFileContent mimeType: ${mime} on comment ${commentId}`);
  return null;
}

/** Result of fetchThreadDetail — full sync metadata + displayable thread. */
export interface ThreadDetailResult {
  comment: DriveComment;
  thread: CommentThread;
}

/**
 * Fetches a single comment thread from Drive by ID, returning both
 * sync metadata (DriveComment) and the displayable thread content.
 * Uses the same fields and parsing as fetchCommentData so the sync
 * logic can use the same code paths for single and batch updates.
 */
export async function fetchThreadDetail(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  commentId: string,
  userEmail?: string,
): Promise<ThreadDetailResult | null> {
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();
  const emailLower = userEmail?.toLowerCase();

  // Request the superset of sync + display fields
  const fields = buildCommentFields({ sync: true, threads: true, userEmail });

  const res = await drive.comments.get({
    fileId: googleDocId,
    commentId,
    fields,
  });
  logInfo(`[Drive] comments.get ${googleDocId} comment=${commentId} (${Date.now() - t0}ms)`);

  const c = res.data;
  if (!c.id || c.content == null) return null;

  const raw = c as RawDriveComment;
  const comment = parseDriveComment(raw, emailLower);
  const thread = parseCommentThread(raw);
  if (!thread) return null;

  return { comment, thread };
}


// Creates a reply on a Drive comment thread. Replying to a resolved thread
// reopens it automatically. Pass resolve=true to resolve (with optional content).
export async function replyToComment(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  commentId: string,
  content: string,
  resolve?: boolean
): Promise<void> {
  const drive = createDrive({ version: "v3", auth });
  const body: { content?: string; action?: string } = {};
  if (content) body.content = content;
  if (resolve) body.action = "resolve";
  const tag = resolve ? (content ? " (reply+resolve)" : " (resolve)") : "";
  const t0 = Date.now();
  await drive.replies.create({
    fileId: googleDocId,
    commentId,
    fields: "id",
    requestBody: body,
  });
  logInfo(`[Drive] replies.create${tag} ${googleDocId} comment=${commentId} (${Date.now() - t0}ms)`);
}

// Exports a Google Workspace file as plain text via the Drive API.
// Works for Slides (and Sheets) without needing additional OAuth scopes.
// Returns null on error.
export async function fetchFileTextViaExport(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  fileId: string
): Promise<string | null> {
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();

  try {
    const res = await drive.files.export({
      fileId,
      mimeType: "text/plain",
    });
    const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
    logInfo(`[Drive] files.export ${fileId} (plain text, ${text.length} chars) (${Date.now() - t0}ms)`);
    return text;
  } catch (err) {
    logError(`[Drive] files.export ${fileId} (plain text) failed (${Date.now() - t0}ms):`, err);
    return null;
  }
}

export async function getChangesStartPageToken(userId: string): Promise<string> {
  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();
  const res = await drive.changes.getStartPageToken({});
  logInfo(`[Drive] changes.getStartPageToken → ${res.data.startPageToken} (${Date.now() - t0}ms)`);
  return res.data.startPageToken!;
}

export interface DriveChangesResult {
  docs: DriveDoc[];
  trashedDocIds: Set<string>;
  removedDocIds: Set<string>;
  newPageToken: string;
  rawChangeCount: number;
  /** Earliest change timestamp from the changes feed (undefined if no changes had a time field). */
  oldestChangeTime?: Date;
}

export async function listChanges(
  userId: string,
  pageToken: string,
  onProgress?: (stats: { count: number; docsCount: number; deletedCount: number }) => void
): Promise<DriveChangesResult> {
  logInfo(`[Drive] listChanges: starting with token ${pageToken}`);
  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });

  // Collect all changes, deduplicating by fileId (keep last entry per file)
  const changesByFileId = new Map<string, { removed: boolean; file?: { id?: string | null; name?: string | null; mimeType?: string | null; webViewLink?: string | null; modifiedTime?: string | null; createdTime?: string | null; owners?: { me?: boolean | null; displayName?: string | null }[] | null; trashed?: boolean | null } | null }>();
  let currentToken: string | undefined = pageToken;
  let newStartToken: string | undefined;
  let rawChangeCount = 0;
  let oldestChangeTime: Date | undefined;

  do {
    const t0 = Date.now();
    const res: any = await withProgressLogging(
      drive.changes.list({
        pageToken: currentToken,
        fields: "nextPageToken, newStartPageToken, changes(time, removed, fileId, file(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed))",
        pageSize: 1000,
        includeRemoved: true,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      `[Drive] changes.list${currentToken ? " (page)" : ""}`
    );
    const pageChanges = res.data.changes ?? [];
    rawChangeCount += pageChanges.length;
    logInfo(`[Drive] changes.list (page ${currentToken ?? "null"}) → ${pageChanges.length} changes (${Date.now() - t0}ms)`);

    for (const change of pageChanges) {
      if (!change.fileId) continue;
      changesByFileId.set(change.fileId, {
        removed: change.removed === true,
        file: change.file,
      });
      // Track the oldest change time to establish an unarchive cutoff
      if (change.time) {
        const t = new Date(change.time);
        if (!oldestChangeTime || t < oldestChangeTime) oldestChangeTime = t;
      }
    }

    // Report progress based on unique supported files and raw changes found so far
    let docsCount = 0;
    let deletedCount = 0;
    for (const c of changesByFileId.values()) {
      if (c.removed || c.file?.trashed === true) {
        deletedCount++;
      } else if (c.file?.mimeType && SUPPORTED_MIME_TYPES.has(c.file.mimeType)) {
        docsCount++;
      }
    }
    onProgress?.({ count: rawChangeCount, docsCount, deletedCount });

    if (res.data.newStartPageToken) {
      newStartToken = res.data.newStartPageToken;
    }
    currentToken = res.data.nextPageToken ?? undefined;
  } while (currentToken);

  // Use the new start token from the last page, or fall back to the input token if none returned.
  const newPageToken = newStartToken ?? pageToken;

  const docs: DriveDoc[] = [];
  const trashedDocIds = new Set<string>();
  const removedDocIds = new Set<string>();

  for (const [fileId, change] of changesByFileId) {
    if (change.file?.trashed === true) {
      trashedDocIds.add(fileId);
      continue;
    }
    if (change.removed) {
      removedDocIds.add(fileId);
      continue;
    }

    const file = change.file;
    if (!file?.id || !file.name || !file.mimeType) continue;
    if (!SUPPORTED_MIME_TYPES.has(file.mimeType)) continue;

    const isOwner = file.owners?.some((o) => o.me === true) ?? false;
    docs.push({
      googleDocId: file.id,
      title: file.name,
      driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
      mimeType: file.mimeType,
      role: isOwner ? "AUTHOR" : "REVIEWER",
      lastModifiedInDrive: file.modifiedTime ? new Date(file.modifiedTime) : null,
      createdTimeInDrive: file.createdTime ? new Date(file.createdTime) : null,
    });
  }

  logInfo(`[Drive] changes summary: ${docs.length} changed docs, ${trashedDocIds.size} trashed, ${removedDocIds.size} removed (${changesByFileId.size} total changes), next token: ${newPageToken}`);
  return { docs, trashedDocIds, removedDocIds, newPageToken, rawChangeCount, oldestChangeTime };
}

/** Fetch Drive metadata for specific doc IDs (via individual files.get calls). */
export async function fetchDocsByIds(
  userId: string,
  docIds: string[],
  onProgress?: (count: number) => void
): Promise<DriveDoc[]> {
  if (docIds.length === 0) return [];

  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });

  let completedCount = 0;
  onProgress?.(0);

  const results = await Promise.all(
    docIds.map(async (id) => {
      const t0 = Date.now();
      try {
        const res = await drive.files.get({
          fileId: id,
          fields: "id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName)",
          supportsAllDrives: true,
        });
        const file = res.data;
        const isOwner = file.owners?.some((o) => o.me === true) ?? false;
        logInfo(`[Drive] files.get ${id} (${Date.now() - t0}ms)`);
        return {
          googleDocId: id,
          title: file.name ?? id,
          driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${id}/edit`,
          mimeType: file.mimeType ?? "",
          role: (isOwner ? "AUTHOR" : "REVIEWER") as "AUTHOR" | "REVIEWER",
          lastModifiedInDrive: file.modifiedTime ? new Date(file.modifiedTime) : null,
          createdTimeInDrive: file.createdTime ? new Date(file.createdTime) : null,
        };
      } catch (err: unknown) {
        const code = (err as { code?: number | string })?.code;
        if (code === 404 || code === "404" || code === 403 || code === "403") {
          logWarning(`[Drive] files.get ${id} → ${code === 403 || code === "403" ? "permission denied" : "not found"} (${Date.now() - t0}ms)`);
        } else {
          logError(`[Drive] files.get ${id} failed (${Date.now() - t0}ms):`, err);
        }
        return null;
      } finally {
        completedCount++;
        onProgress?.(completedCount);
      }
    })
  );

  return results.filter((d): d is DriveDoc => d !== null);
}

export interface ListRecentDocsOptions {
  ownership?: "all" | "owned" | "shared-with-me";
  includeSharedDrives?: boolean;
}

export async function listRecentDocs(
  userId: string,
  since?: Date | null,
  options?: ListRecentDocsOptions,
  onProgress?: (stats: { count: number; docsCount: number; deletedCount: number }) => void
): Promise<DriveDoc[]> {
  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });

  // since: Date = filter by that date, undefined = 7-day default, null = no time filter
  const cutoff = since === null ? null : (since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const ownership = options?.ownership ?? "all";
  const includeSharedDrives = options?.includeSharedDrives ?? false;

  // Guard against invalid dates (overflow from large daysBack values) — treat as all-time
  const safeCutoff = cutoff && !isNaN(cutoff.getTime()) ? cutoff : null;
  // Build query
  const qParts = [
    "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation')",
    "trashed = false",
  ];
  if (safeCutoff) {
    qParts.push(`modifiedTime > '${safeCutoff.toISOString()}'`);
  }
  if (ownership === "owned") qParts.push("'me' in owners");
  if (ownership === "shared-with-me") qParts.push("sharedWithMe");
  const q = qParts.join(" and ");

  logInfo(`[Drive] files.list query: ${q}${includeSharedDrives ? " (including shared drives)" : ""}`);

  const docs: DriveDoc[] = [];
  let pageToken: string | undefined;
  let rawCount = 0;

  do {
    const t0 = Date.now();
    const res = await withProgressLogging(
      drive.files.list({
        q,
        fields:
          "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName))",
        pageSize: 1000,
        pageToken,
        ...(includeSharedDrives
          ? { corpora: "allDrives", includeItemsFromAllDrives: true, supportsAllDrives: true }
          : {}),
      }),
      `[Drive] files.list (recent docs${pageToken ? " page" : ""})`
    );
    const pageFiles = res.data.files ?? [];
    rawCount += pageFiles.length;
    logInfo(`[Drive] files.list (recent docs${pageToken ? ", page " + pageToken : ""}) → ${pageFiles.length} files (${Date.now() - t0}ms)`);

    for (const file of pageFiles) {
      if (!file.id || !file.name) continue;
      const isOwner = file.owners?.some((o) => o.me === true) ?? false;
      docs.push({
        googleDocId: file.id,
        title: file.name,
        driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
        mimeType: file.mimeType ?? "",
        role: isOwner ? "AUTHOR" : "REVIEWER",
        lastModifiedInDrive: file.modifiedTime ? new Date(file.modifiedTime) : null,
        createdTimeInDrive: file.createdTime ? new Date(file.createdTime) : null,
      });
    }

    onProgress?.({ count: rawCount, docsCount: docs.length, deletedCount: 0 });

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return docs;
}

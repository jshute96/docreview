import { drive as createDrive } from "@googleapis/drive";
import { docs as createDocs } from "@googleapis/docs";
import { OAuth2Client } from "google-auth-library";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, OfflineModeError } from "@/lib/offline";
import { logError, logWarning, logInfo, logToFile } from "@/lib/log";
import { withProgressLogging } from "./promise-utils";

const DEBUG_FILE = "drive-changes-debug.log";
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
  owner: string | null;
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
        const res = await drive.files.get({ fileId: id, fields: "trashed" });
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
  iParticipated: boolean;
  iResolvedIt: boolean;
  isRead: boolean;
  mentionedMe: boolean;
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
): { isThreadAuthor: boolean; iParticipated: boolean; iResolvedIt: boolean; isRead: boolean } {
  const isThreadAuthor = author?.me === true;
  const iParticipated = isThreadAuthor || replies.some(
    (r) => r.author?.me === true
  );
  const lastResolveReply = [...replies]
    .reverse()
    .find((r) => r.action === "resolve");
  const iResolvedIt = lastResolveReply?.author?.me === true;
  const isRead = replies.length > 0
    ? replies[replies.length - 1].author?.me === true
    : author?.me === true;
  return { isThreadAuthor, iParticipated, iResolvedIt, isRead };
}

export async function fetchComments(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  since?: Date,
  userEmail?: string
): Promise<DriveComment[]> {
  const drive = createDrive({ version: "v3", auth });
  const sinceStr = since ? since.toISOString() : undefined;
  const t0 = Date.now();
  const emailLower = userEmail?.toLowerCase();

  const comments: DriveComment[] = [];
  let pageToken: string | undefined;

  do {
    const res = await withProgressLogging(
      drive.comments.list({
        fileId: googleDocId,
        fields:
          "nextPageToken, comments(id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me), mentionedEmailAddresses), mentionedEmailAddresses)",
        ...(sinceStr ? { startModifiedTime: sinceStr } : {}),
        ...(pageToken ? { pageToken } : {}),
      }),
      `[Drive] comments.list ${googleDocId}${pageToken ? " (page)" : ""}`
    );

    const items = res.data.comments ?? [];
    for (const c of items) {
      if (!c.id) continue;
      const replies = c.replies ?? [];
      const flags = deriveCommentFlags(c.author, replies);

      const mentionedMe = emailLower
        ? (c.mentionedEmailAddresses ?? []).some((e) => e.toLowerCase() === emailLower)
        : false;
      const replyMentionedMeFlags = replies.map((r) =>
        emailLower
          ? ((r as { mentionedEmailAddresses?: string[] }).mentionedEmailAddresses ?? []).some(
              (e) => e.toLowerCase() === emailLower
            )
          : false
      );

      comments.push({
        id: c.id,
        resolved: c.resolved === true,
        ...flags,
        mentionedMe,
        driveCreatedAt: c.createdTime ? new Date(c.createdTime) : null,
        driveModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
        replyCount: replies.length,
        replyAuthorMeFlags: replies.map((r) => r.author?.me === true),
        replyMentionedMeFlags,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  logInfo(
    `[Drive] comments.list ${googleDocId} (since ${since ? formatDate(since) : "all"}) → ${comments.length} comments (${Date.now() - t0}ms)`
  );
  return comments;
}

export interface DriveSuggestion {
  id: string;
  suggestionType: "INSERT" | "DELETE" | "EDIT";
}

export interface SuggestionContent {
  insertedText: string;
  deletedText: string;
}

// Walks a Docs document body and extracts all pending suggestions.
// Returns metadata only (no text content) — use fetchDocContent for display text.
export async function fetchSuggestions(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<DriveSuggestion[]> {
  const docs = createDocs({ version: "v1", auth });
  const t0 = Date.now();

  const res = await withProgressLogging(
    docs.documents.get({
      documentId: googleDocId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      fields: "body(content(paragraph(elements(textRun(suggestedInsertionIds,suggestedDeletionIds)))))",
    }),
    `[Docs] documents.get ${googleDocId} (suggestions)`
  );
  const elapsed = Date.now() - t0;

  const insertionIds = new Set<string>();
  const deletionIds = new Set<string>();

  for (const el of res.data.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      for (const id of pe.textRun?.suggestedInsertionIds ?? []) {
        insertionIds.add(id);
      }
      for (const id of pe.textRun?.suggestedDeletionIds ?? []) {
        deletionIds.add(id);
      }
    }
  }

  const allIds = new Set([...insertionIds, ...deletionIds]);
  const suggestions: DriveSuggestion[] = [];

  for (const id of allIds) {
    const hasInsert = insertionIds.has(id);
    const hasDelete = deletionIds.has(id);
    suggestions.push({
      id,
      suggestionType: hasInsert && hasDelete ? "EDIT" : hasInsert ? "INSERT" : "DELETE",
    });
  }

  logInfo(`[Docs] documents.get ${googleDocId} → ${suggestions.length} suggestions (${elapsed}ms)`);
  return suggestions;
}

// Fetches document text and suggestion content in a single Docs API call.
// Uses SUGGESTIONS_INLINE so both pending insertions and deletions are visible
// alongside the base text. This means documentText includes suggestion text —
// anchor-text matching may give false results if a suggestion overlaps the
// anchor region, but the consequence is only a spurious "not found" warning.
export async function fetchDocContent(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<{ documentText: string | null; suggestions: Record<string, SuggestionContent> }> {
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
      `[Docs] documents.get ${googleDocId} (content)`
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
          `[Docs] documents.get ${googleDocId} (content, no suggestions)`
        );
      } catch (innerErr) {
        logError(
          `[Docs] documents.get ${googleDocId} failed even without suggestions (${
            Date.now() - t0
          }ms):`,
          innerErr
        );
        return { documentText: null, suggestions: {} };
      }
    } else {
      const isPermission = err.code === 403 || err.code === 404 ||
        /permission|forbidden|not found/i.test(err.message ?? "");
      if (isPermission) {
        logError(`[Docs] documents.get ${googleDocId} failed (${Date.now() - t0}ms): ${err.message ?? err}`);
      } else {
        logError(`[Docs] documents.get ${googleDocId} failed (${Date.now() - t0}ms):`, err);
      }
      return { documentText: null, suggestions: {} };
    }
  }

  const textParts: string[] = [];
  const insertions: Record<string, string> = {};
  const deletions: Record<string, string> = {};

  for (const el of res.data.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const run = pe.textRun;
      if (!run?.content) continue;
      textParts.push(run.content);
      // Strip trailing newline that Docs API appends to paragraph-ending runs
      const text = run.content.replace(/\n$/, "");
      if (!text) continue;
      for (const id of run.suggestedInsertionIds ?? []) {
        insertions[id] = (insertions[id] ?? "") + text;
      }
      for (const id of run.suggestedDeletionIds ?? []) {
        deletions[id] = (deletions[id] ?? "") + text;
      }
    }
  }

  const documentText = textParts.join("");
  const allIds = new Set([...Object.keys(insertions), ...Object.keys(deletions)]);
  const suggestions: Record<string, SuggestionContent> = {};
  for (const id of allIds) {
    suggestions[id] = {
      insertedText: insertions[id] ?? "",
      deletedText: deletions[id] ?? "",
    };
  }

  logInfo(`[Docs] documents.get ${googleDocId} (doc content: ${documentText.length} chars, ${allIds.size} suggestions) (${Date.now() - t0}ms)`);
  return { documentText, suggestions };
}

// A single reply within a comment thread (not the initial comment).
export interface ThreadReply {
  author: string;
  fromMe: boolean;
  content: string;
  htmlContent?: string;
  createdTime: string;
  action?: "resolve" | "reopen";
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

// Full Drive data for a single comment thread: sync metadata (for DB update)
// plus the displayable thread content. Returned by fetchThreadDetail().
export interface DriveThreadDetail {
  resolved: boolean;
  isThreadAuthor: boolean;
  iParticipated: boolean;
  iResolvedIt: boolean;
  isRead: boolean;
  driveCreatedAt: Date | null;
  driveModifiedAt: Date | null;
  replyCount: number;
  thread: CommentThread;
}

// Fetches a single comment thread from Drive by ID, returning both
// sync metadata and the full displayable thread (initial comment + replies).
export async function fetchThreadDetail(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  commentId: string
): Promise<DriveThreadDetail | null> {
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();

  const res = await drive.comments.get({
    fileId: googleDocId,
    commentId,
    fields:
      "id, resolved, content, htmlContent, quotedFileContent(mimeType, value), createdTime, modifiedTime, author(me, displayName), replies(content, htmlContent, createdTime, action, author(me, displayName))",
  });
  logInfo(`[Drive] comments.get ${googleDocId} comment=${commentId} (${Date.now() - t0}ms)`);

  const c = res.data;
  if (!c.id || c.content == null) return null;

  const allReplies = c.replies ?? [];
  const flags = deriveCommentFlags(c.author, allReplies);

  const threadReplies: ThreadReply[] = allReplies.map((r) => ({
    author: r.author?.displayName ?? "Unknown",
    fromMe: r.author?.me === true,
    content: r.content ?? "",
    ...(r.htmlContent ? { htmlContent: r.htmlContent } : {}),
    createdTime: r.createdTime ?? "",
    ...(r.action === "resolve" || r.action === "reopen" ? { action: r.action } : {}),
  }));

  return {
    resolved: c.resolved === true,
    ...flags,
    driveCreatedAt: c.createdTime ? new Date(c.createdTime) : null,
    driveModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
    replyCount: allReplies.length,
    thread: {
      id: c.id,
      author: c.author?.displayName ?? "Unknown",
      fromMe: c.author?.me === true,
      content: c.content,
      ...(c.htmlContent ? { htmlContent: c.htmlContent } : {}),
      createdTime: c.createdTime ?? "",
      resolved: c.resolved === true,
      replies: threadReplies,
      quotedFileContent: extractQuotedFileContent(c.quotedFileContent, c.id),
    },
  };
}

// Fetches all comment threads for a document from Drive (paginated).
export async function fetchAllThreads(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<CommentThread[]> {
  const drive = createDrive({ version: "v3", auth });
  const t0 = Date.now();

  const threads: CommentThread[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const res = await withProgressLogging(
        drive.comments.list({
          fileId: googleDocId,
          fields:
            "nextPageToken, comments(id, resolved, content, htmlContent, quotedFileContent(mimeType, value), createdTime, modifiedTime, author(me, displayName), replies(content, htmlContent, createdTime, action, author(me, displayName)))",
          pageSize: 100,
          ...(pageToken ? { pageToken } : {}),
        }),
        `[Drive] comments.list ${googleDocId} (threads${pageToken ? " page" : ""})`
      );

      for (const c of res.data.comments ?? []) {
        if (!c.id || c.content == null) continue;

        const replies: ThreadReply[] = (c.replies ?? []).map((r) => ({
          author: r.author?.displayName ?? "Unknown",
          fromMe: r.author?.me === true,
          content: r.content ?? "",
          ...(r.htmlContent ? { htmlContent: r.htmlContent } : {}),
          createdTime: r.createdTime ?? "",
          ...(r.action === "resolve" || r.action === "reopen" ? { action: r.action } : {}),
        }));

        threads.push({
          id: c.id,
          author: c.author?.displayName ?? "Unknown",
          fromMe: c.author?.me === true,
          content: c.content,
          ...(c.htmlContent ? { htmlContent: c.htmlContent } : {}),
          createdTime: c.createdTime ?? "",
          ...(c.modifiedTime ? { modifiedTime: c.modifiedTime } : {}),
          resolved: c.resolved === true,
          replies,
          quotedFileContent: extractQuotedFileContent(c.quotedFileContent, c.id),
        });
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    if (err.code === 403) {
      logWarning(`[Drive] Permission denied for comments on ${googleDocId}.`);
      return [];
    }
    throw err;
  }

  logInfo(
    `[Drive] comments.list ${googleDocId} (threads) → ${
      threads.length
    } threads (${Date.now() - t0}ms)`
  );
  return threads;
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

  do {
    const t0 = Date.now();
    const res: any = await withProgressLogging(
      drive.changes.list({
        pageToken: currentToken,
        fields: "nextPageToken, newStartPageToken, changes(removed, fileId, file(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed))",
        pageSize: 1000,
        includeRemoved: true,
      }),
      `[Drive] changes.list${currentToken ? " (page)" : ""}`
    );
    const pageChanges = res.data.changes ?? [];
    rawChangeCount += pageChanges.length;
    logInfo(`[Drive] changes.list (page ${currentToken ?? "null"}) → ${pageChanges.length} changes (${Date.now() - t0}ms)`);

    for (const change of pageChanges) {
      if (!change.fileId) continue;
      logToFile(DEBUG_FILE, `RAW CHANGE: "${change.file?.name}" (ID: ${change.fileId})`, { change });
      changesByFileId.set(change.fileId, {
        removed: change.removed === true,
        file: change.file,
      });
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
      owner: file.owners?.[0]?.displayName ?? null,
    });
  }

  logInfo(`[Drive] changes summary: ${docs.length} changed docs, ${trashedDocIds.size} trashed, ${removedDocIds.size} removed (${changesByFileId.size} total changes), next token: ${newPageToken}`);
  return { docs, trashedDocIds, removedDocIds, newPageToken, rawChangeCount };
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
        logInfo(`[Drive] files.get ${id} → "${file.name}" (${Date.now() - t0}ms)`);
        return {
          googleDocId: id,
          title: file.name ?? id,
          driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${id}/edit`,
          mimeType: file.mimeType ?? "",
          role: (isOwner ? "AUTHOR" : "REVIEWER") as "AUTHOR" | "REVIEWER",
          lastModifiedInDrive: file.modifiedTime ? new Date(file.modifiedTime) : null,
          createdTimeInDrive: file.createdTime ? new Date(file.createdTime) : null,
          owner: file.owners?.[0]?.displayName ?? null,
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
  since?: Date,
  options?: ListRecentDocsOptions,
  onProgress?: (stats: { count: number; docsCount: number; deletedCount: number }) => void
): Promise<DriveDoc[]> {
  const auth = await getDriveClient(userId);
  const drive = createDrive({ version: "v3", auth });

  const cutoff = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const modifiedAfter = cutoff.toISOString();
  const ownership = options?.ownership ?? "all";
  const includeSharedDrives = options?.includeSharedDrives ?? false;

  // Build query
  const qParts = [
    "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation')",
    `modifiedTime > '${modifiedAfter}'`,
    "trashed = false",
  ];
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
      logToFile(DEBUG_FILE, `RAW FILE: "${file.name}" (ID: ${file.id})`, { file });
      const isOwner = file.owners?.some((o) => o.me === true) ?? false;
      docs.push({
        googleDocId: file.id,
        title: file.name,
        driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
        mimeType: file.mimeType ?? "",
        role: isOwner ? "AUTHOR" : "REVIEWER",
        lastModifiedInDrive: file.modifiedTime ? new Date(file.modifiedTime) : null,
        createdTimeInDrive: file.createdTime ? new Date(file.createdTime) : null,
        owner: file.owners?.[0]?.displayName ?? null,
      });
    }

    onProgress?.({ count: rawCount, docsCount: docs.length, deletedCount: 0 });

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return docs;
}

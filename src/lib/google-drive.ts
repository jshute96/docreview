import { google } from "googleapis";
import { prisma } from "@/lib/prisma";
import { OFFLINE_MODE, OfflineModeError } from "@/lib/offline";

export const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

export function parseGoogleDocId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

export async function getDriveClient(userId: string) {
  if (OFFLINE_MODE) throw new OfflineModeError("getDriveClient");

  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.access_token) {
    throw new Error("No Google account found for user");
  }

  const oauth2Client = new google.auth.OAuth2(
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
      console.error("[Auth] Failed to persist refreshed tokens:", err);
    }
  });

  return oauth2Client;
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

// Returns the subset of googleDocIds that are deleted (trashed, permanently deleted, or access revoked).
// Runs all files.get calls in parallel rather than sequentially.
export async function findDeletedDocIds(
  userId: string,
  googleDocIds: string[]
): Promise<Set<string>> {
  if (googleDocIds.length === 0) return new Set();

  const auth = await getDriveClient(userId);
  const drive = google.drive({ version: "v3", auth });

  const results = await Promise.all(
    googleDocIds.map(async (id) => {
      const t0 = Date.now();
      try {
        const res = await drive.files.get({ fileId: id, fields: "trashed" });
        const deleted = res.data.trashed === true;
        console.log(`[Drive] files.get ${id} → ${deleted ? "deleted/trashed" : "ok"} (${Date.now() - t0}ms)`);
        return { id, deleted };
      } catch (err: unknown) {
        // Only treat 404/403 as deleted; skip transient errors (429, 5xx, network)
        const code = (err as { code?: number | string })?.code;
        if (code === 404 || code === "404" || code === 403 || code === "403") {
          console.log(`[Drive] files.get ${id} → not found/access revoked (${Date.now() - t0}ms)`);
          return { id, deleted: true };
        }
        console.error(`[Drive] files.get ${id} → transient error (skipping, ${Date.now() - t0}ms):`, err);
        return { id, deleted: false };
      }
    })
  );

  return new Set(results.filter((r) => r.deleted).map((r) => r.id));
}

export interface DriveComment {
  id: string;
  resolved: boolean;
  isThreadAuthor: boolean;
  iParticipated: boolean;
  iResolvedIt: boolean;
  driveCreatedAt: Date | null;
  driveModifiedAt: Date | null;
  replyCount: number;
}

// Derives ownership/participation flags from a Drive comment's author and replies.
export function deriveCommentFlags(
  author: { me?: boolean | null } | undefined | null,
  replies: { action?: string | null; author?: { me?: boolean | null } | null }[]
): { isThreadAuthor: boolean; iParticipated: boolean; iResolvedIt: boolean } {
  const isThreadAuthor = author?.me === true;
  const iParticipated = isThreadAuthor || replies.some(
    (r) => r.author?.me === true
  );
  const lastResolveReply = [...replies]
    .reverse()
    .find((r) => r.action === "resolve");
  const iResolvedIt = lastResolveReply?.author?.me === true;
  return { isThreadAuthor, iParticipated, iResolvedIt };
}

export async function fetchComments(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  since?: Date
): Promise<DriveComment[]> {
  const drive = google.drive({ version: "v3", auth });
  const sinceStr = since ? since.toISOString() : undefined;
  const t0 = Date.now();

  const comments: DriveComment[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields:
        "nextPageToken, comments(id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me)))",
      ...(sinceStr ? { startModifiedTime: sinceStr } : {}),
      ...(pageToken ? { pageToken } : {}),
    });

    const items = res.data.comments ?? [];
    for (const c of items) {
      if (!c.id) continue;
      const replies = c.replies ?? [];
      const flags = deriveCommentFlags(c.author, replies);

      comments.push({
        id: c.id,
        resolved: c.resolved === true,
        ...flags,
        driveCreatedAt: c.createdTime ? new Date(c.createdTime) : null,
        driveModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
        replyCount: replies.length,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(
    `[Drive] comments.list ${googleDocId} (since ${sinceStr ?? "all"}) → ${comments.length} comments (${Date.now() - t0}ms)`
  );
  return comments;
}

// Drive comment ID → "AuthorName: text" for regular comments
export async function fetchCommentContent(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<Record<string, string>> {
  const drive = google.drive({ version: "v3", auth });
  const commentContent: Record<string, string> = {};
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields: "nextPageToken, comments(id, content, author(displayName))",
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const c of res.data.comments ?? []) {
      if (!c.id || c.content == null) continue;
      const author = c.author?.displayName;
      commentContent[c.id] = author ? `${author}: ${c.content}` : c.content;
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return commentContent;
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
// Returns metadata only (no text content) — use fetchSuggestionContent for display text.
export async function fetchSuggestions(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<DriveSuggestion[]> {
  const docs = google.docs({ version: "v1", auth });
  const t0 = Date.now();

  const res = await docs.documents.get({
    documentId: googleDocId,
    suggestionsViewMode: "SUGGESTIONS_INLINE",
    fields: "body(content(paragraph(elements(textRun(suggestedInsertionIds,suggestedDeletionIds)))))",
  });
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

  console.log(`[Docs] documents.get ${googleDocId} → ${suggestions.length} suggestions (${elapsed}ms)`);
  return suggestions;
}

// Fetches the text content of all pending suggestions in a document.
// Returns a map of suggestionId → { insertedText, deletedText } for live display.
export async function fetchSuggestionContent(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<Record<string, SuggestionContent>> {
  const docs = google.docs({ version: "v1", auth });
  const t0 = Date.now();

  let res;
  try {
    res = await docs.documents.get({
      documentId: googleDocId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      fields: "body(content(paragraph(elements(textRun(content,suggestedInsertionIds,suggestedDeletionIds)))))",
    });
  } catch (err) {
    console.error(`[Docs] documents.get ${googleDocId} failed (${Date.now() - t0}ms):`, err);
    return {};
  }
  console.log(`[Docs] documents.get ${googleDocId} (suggestion content) (${Date.now() - t0}ms)`);

  const insertions: Record<string, string> = {};
  const deletions: Record<string, string> = {};

  for (const el of res.data.body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) {
      const run = pe.textRun;
      if (!run?.content) continue;
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

  const allIds = new Set([...Object.keys(insertions), ...Object.keys(deletions)]);
  const result: Record<string, SuggestionContent> = {};

  for (const id of allIds) {
    result[id] = {
      insertedText: insertions[id] ?? "",
      deletedText: deletions[id] ?? "",
    };
  }

  return result;
}

// A single reply within a comment thread (not the initial comment).
export interface ThreadReply {
  author: string;
  content: string;
  createdTime: string;
  action?: "resolve" | "reopen";
}

// A comment thread on a document: the initial comment plus all replies.
// The top-level author/content/createdTime are the initial comment;
// `replies` contains the subsequent responses.
export interface CommentThread {
  id: string;
  author: string;
  content: string;
  createdTime: string;
  resolved: boolean;
  replies: ThreadReply[];
}

// Full Drive data for a single comment thread: sync metadata (for DB update)
// plus the displayable thread content. Returned by fetchThreadDetail().
export interface DriveThreadDetail {
  resolved: boolean;
  isThreadAuthor: boolean;
  iParticipated: boolean;
  iResolvedIt: boolean;
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
  const drive = google.drive({ version: "v3", auth });
  const t0 = Date.now();

  const res = await drive.comments.get({
    fileId: googleDocId,
    commentId,
    fields:
      "id, resolved, content, createdTime, modifiedTime, author(me, displayName), replies(content, createdTime, action, author(me, displayName))",
  });
  console.log(`[Drive] comments.get ${googleDocId} comment=${commentId} (${Date.now() - t0}ms)`);

  const c = res.data;
  if (!c.id || c.content == null) return null;

  const allReplies = c.replies ?? [];
  const flags = deriveCommentFlags(c.author, allReplies);

  const threadReplies: ThreadReply[] = allReplies.map((r) => ({
    author: r.author?.displayName ?? "Unknown",
    content: r.content ?? "",
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
      content: c.content,
      createdTime: c.createdTime ?? "",
      resolved: c.resolved === true,
      replies: threadReplies,
    },
  };
}

// Fetches all comment threads for a document from Drive (paginated).
export async function fetchAllThreads(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<CommentThread[]> {
  const drive = google.drive({ version: "v3", auth });
  const t0 = Date.now();

  const threads: CommentThread[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields:
        "nextPageToken, comments(id, resolved, content, createdTime, author(displayName), replies(content, createdTime, action, author(displayName)))",
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const c of res.data.comments ?? []) {
      if (!c.id || c.content == null) continue;

      const replies: ThreadReply[] = (c.replies ?? []).map((r) => ({
        author: r.author?.displayName ?? "Unknown",
        content: r.content ?? "",
        createdTime: r.createdTime ?? "",
        ...(r.action === "resolve" || r.action === "reopen" ? { action: r.action } : {}),
      }));

      threads.push({
        id: c.id,
        author: c.author?.displayName ?? "Unknown",
        content: c.content,
        createdTime: c.createdTime ?? "",
        resolved: c.resolved === true,
        replies,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(
    `[Drive] comments.list ${googleDocId} (threads) → ${threads.length} threads (${Date.now() - t0}ms)`
  );
  return threads;
}

// Creates a reply on a Drive comment thread. Replying to a resolved thread
// reopens it automatically. Pass resolve=true to resolve instead of reply.
export async function replyToComment(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  commentId: string,
  content: string,
  resolve?: boolean
): Promise<void> {
  const drive = google.drive({ version: "v3", auth });
  const tag = resolve ? " (resolve)" : "";
  const t0 = Date.now();
  await drive.replies.create({
    fileId: googleDocId,
    commentId,
    fields: "id",
    requestBody: resolve ? { action: "resolve" } : { content },
  });
  console.log(`[Drive] replies.create${tag} ${googleDocId} comment=${commentId} (${Date.now() - t0}ms)`);
}

export async function listRecentDocs(userId: string, since?: Date): Promise<DriveDoc[]> {
  const auth = await getDriveClient(userId);
  const drive = google.drive({ version: "v3", auth });

  const cutoff = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const modifiedAfter = cutoff.toISOString();

  const docs: DriveDoc[] = [];
  let pageToken: string | undefined;

  do {
    const t0 = Date.now();
    const res = await drive.files.list({
      q: `(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation') and modifiedTime > '${modifiedAfter}' and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName))",
      pageSize: 100,
      pageToken,
    });
    console.log(`[Drive] files.list (recent docs${pageToken ? ", page " + pageToken.slice(0, 8) + "…" : ""}) → ${res.data.files?.length ?? 0} files (${Date.now() - t0}ms)`);

    const files = res.data.files ?? [];
    for (const file of files) {
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
        owner: file.owners?.[0]?.displayName ?? null,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return docs;
}

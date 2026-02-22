import { google } from "googleapis";
import { prisma } from "@/lib/prisma";

export async function getDriveClient(userId: string) {
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
      try {
        console.log(`[Drive] files.get ${id}`);
        const res = await drive.files.get({ fileId: id, fields: "trashed" });
        const deleted = res.data.trashed === true;
        console.log(`[Drive] files.get ${id} → ${deleted ? "deleted/trashed" : "ok"}`);
        return { id, deleted };
      } catch {
        console.log(`[Drive] files.get ${id} → not found (deleted)`);
        return { id, deleted: true };
      }
    })
  );

  return new Set(results.filter((r) => r.deleted).map((r) => r.id));
}

export interface DriveComment {
  id: string;
  resolved: boolean;
  isMine: boolean;
  iParticipated: boolean;
  iResolvedIt: boolean;
  driveCreatedAt: Date | null;
  driveModifiedAt: Date | null;
  replyCount: number;
  // Set if this comment is a Google Docs suggestion (detected via anchor field)
  isSuggestion: boolean;
  // Docs API suggestion ID extracted from the anchor JSON (used to look up content)
  docsSuggestionId?: string;
}

export async function fetchComments(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string,
  since?: Date
): Promise<DriveComment[]> {
  const drive = google.drive({ version: "v3", auth });
  const sinceStr = since ? since.toISOString() : undefined;
  console.log(
    `[Drive] comments.list ${googleDocId} (since ${sinceStr ?? "all"})`
  );

  const comments: DriveComment[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields:
        "nextPageToken, comments(id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me)), anchor)",
      ...(sinceStr ? { startModifiedTime: sinceStr } : {}),
      ...(pageToken ? { pageToken } : {}),
    });

    const items = res.data.comments ?? [];
    for (const c of items) {
      if (!c.id) continue;
      const replies = c.replies ?? [];
      const isMine = c.author?.me === true;
      const iParticipated = replies.some(
        (r) => r.action !== "resolve" && r.author?.me === true
      );
      const lastResolveReply = [...replies]
        .reverse()
        .find((r) => r.action === "resolve");
      const iResolvedIt = lastResolveReply?.author?.me === true;

      // Detect suggestion comments via their anchor.
      // Two formats exist:
      //   Older docs: plain "kix.xxx" string
      //   Newer docs: JSON {"r":"head","a":[{"ct":"sgst","si":"suggest.xxx"}]}
      let isSuggestion = false;
      let docsSuggestionId: string | undefined;
      if (c.anchor) {
        if (c.anchor.startsWith("kix.")) {
          isSuggestion = true;
          // kix.xxx anchor — no Docs API suggestion ID available
        } else {
          try {
            const anchor = JSON.parse(c.anchor) as {
              a?: Array<{ ct?: string; si?: unknown }>;
            };
            const firstAction = anchor?.a?.[0];
            if (firstAction?.ct === "sgst") {
              isSuggestion = true;
              if (typeof firstAction.si === "string") {
                docsSuggestionId = firstAction.si;
              }
            }
          } catch { /* non-JSON anchor or unexpected format */ }
        }
      }

      comments.push({
        id: c.id,
        resolved: c.resolved === true,
        isMine,
        iParticipated,
        iResolvedIt,
        driveCreatedAt: c.createdTime ? new Date(c.createdTime) : null,
        driveModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
        replyCount: replies.length,
        isSuggestion,
        docsSuggestionId,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(
    `[Drive] comments.list ${googleDocId} (since ${sinceStr ?? "all"}) → ${comments.length} comments`
  );
  return comments;
}

export interface CommentContentResult {
  // Drive comment ID → "AuthorName: text" for regular comments
  commentContent: Record<string, string>;
  // Drive comment ID → Docs API suggestion ID (for suggestion content lookup)
  driveIdToDocsId: Record<string, string>;
}

export async function fetchCommentContent(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<CommentContentResult> {
  const drive = google.drive({ version: "v3", auth });
  const commentContent: Record<string, string> = {};
  const driveIdToDocsId: Record<string, string> = {};
  let pageToken: string | undefined;

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields: "nextPageToken, comments(id, content, author(displayName), anchor)",
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const c of res.data.comments ?? []) {
      if (!c.id) continue;

      // Extract Docs API suggestion ID from anchor for suggestion comments
      if (c.anchor) {
        try {
          const anchor = JSON.parse(c.anchor) as {
            a?: Array<{ ct?: string; si?: unknown }>;
          };
          const firstAction = anchor?.a?.[0];
          if (firstAction?.ct === "sgst" && typeof firstAction.si === "string") {
            driveIdToDocsId[c.id] = firstAction.si;
            continue; // suggestion content comes from Docs API, not Drive
          }
        } catch { /* unexpected anchor format */ }
      }

      if (c.content != null) {
        const author = c.author?.displayName;
        commentContent[c.id] = author ? `${author}: ${c.content}` : c.content;
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { commentContent, driveIdToDocsId };
}

export interface DriveSuggestion {
  id: string;
  suggestionType: "INSERT" | "DELETE" | "EDIT";
}

// Fetches a mapping of Docs API suggestion ID → Drive comment ID by scanning all comments
// (no since filter). This is needed because the since filter used in fetchComments hides
// suggestions that haven't been touched recently, and we need the Drive comment ID for
// correct ?disco= URL navigation.
export async function fetchDriveSuggestionIds(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<Map<string, string>> {
  const drive = google.drive({ version: "v3", auth });
  const result = new Map<string, string>(); // docsSuggestionId → driveCommentId
  let pageToken: string | undefined;

  console.log(`[Drive] comments.list ${googleDocId} (suggestion ID mapping)`);

  do {
    const res = await drive.comments.list({
      fileId: googleDocId,
      fields: "nextPageToken, comments(id, anchor)",
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });

    for (const c of res.data.comments ?? []) {
      if (!c.id || !c.anchor) continue;
      console.log(`[Drive] comment ${c.id} anchor: ${c.anchor}`);
      // Suggestion anchors are plain kix.xxx strings, not JSON
      if (c.anchor.startsWith("kix.")) {
        result.set(c.anchor, c.id); // kix.xxx → AAAB0xxx Drive comment ID
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  console.log(`[Drive] comments.list ${googleDocId} (suggestion ID mapping) → ${result.size} suggestions found`);
  return result;
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
  console.log(`[Docs] documents.get ${googleDocId} (suggestions)`);

  let res;
  try {
    res = await docs.documents.get({
      documentId: googleDocId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      fields: "body(content(paragraph(elements(textRun(suggestedInsertionIds,suggestedDeletionIds)))))",
    });
  } catch (err) {
    console.error(`[Docs] documents.get ${googleDocId} failed:`, err);
    return [];
  }

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

  console.log(`[Docs] documents.get ${googleDocId} → ${suggestions.length} suggestions`);
  return suggestions;
}

// Fetches the text content of all pending suggestions in a document.
// Returns a map of suggestionId → { insertedText, deletedText } for live display.
export async function fetchSuggestionContent(
  auth: Awaited<ReturnType<typeof getDriveClient>>,
  googleDocId: string
): Promise<Record<string, SuggestionContent>> {
  const docs = google.docs({ version: "v1", auth });
  console.log(`[Docs] documents.get ${googleDocId} (suggestion content)`);

  let res;
  try {
    res = await docs.documents.get({
      documentId: googleDocId,
      suggestionsViewMode: "SUGGESTIONS_INLINE",
      fields: "body(content(paragraph(elements(textRun(content,suggestedInsertionIds,suggestedDeletionIds)))))",
    });
  } catch (err) {
    console.error(`[Docs] documents.get ${googleDocId} failed:`, err);
    return {};
  }

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

export async function listRecentDocs(userId: string): Promise<DriveDoc[]> {
  const auth = await getDriveClient(userId);
  const drive = google.drive({ version: "v3", auth });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const modifiedAfter = thirtyDaysAgo.toISOString();

  const docs: DriveDoc[] = [];
  let pageToken: string | undefined;

  do {
    console.log(`[Drive] files.list (recent docs${pageToken ? ", page " + pageToken.slice(0, 8) + "…" : ""})`);
    const res = await drive.files.list({
      q: `(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation') and modifiedTime > '${modifiedAfter}' and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName))",
      pageSize: 100,
      pageToken,
    });
    console.log(`[Drive] files.list → ${res.data.files?.length ?? 0} files`);

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

import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// Syncs all comments and suggestions for a single doc. Always does a full scan —
// Drive API's startModifiedTime filter silently excludes suggestions.
// Returns the number of new comment records created.
export async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>
): Promise<number> {
  let comments;
  try {
    comments = await fetchComments(driveAuth, doc.googleDocId);
  } catch (err) {
    console.error(`[Comments] failed for ${doc.googleDocId}:`, err);
    return 0;
  }

  // All Drive API results are regular comments. Suggestions come exclusively from Docs API.
  let docsSuggestionsForSync: Awaited<ReturnType<typeof fetchSuggestions>> = [];
  if (doc.mimeType === DOCS_MIME_TYPE) {
    try {
      docsSuggestionsForSync = await fetchSuggestions(driveAuth, doc.googleDocId);
    } catch (err) {
      console.error(`[Suggestions] fetch failed for ${doc.googleDocId}:`, err);
    }
  }

  let created = 0;

  for (const c of comments) {
    const existing = await prisma.comment.findUnique({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: c.id } },
    });

    if (!existing) {
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.create({
        data: {
          docId: doc.id,
          googleCommentId: c.id,
          type: "COMMENT",
          resolved: c.resolved,
          isMine: c.isMine,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
      created++;
    } else {
      if (existing.status === "MUTED") {
        await prisma.comment.update({
          where: { id: existing.id },
          data: {
            resolved: c.resolved,
            iParticipated: c.iParticipated,
            driveCreatedAt: c.driveCreatedAt,
            driveModifiedAt: c.driveModifiedAt,
            replyCount: c.replyCount,
          },
        });
        continue;
      }
      const status = c.resolved && c.iResolvedIt ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.update({
        where: { id: existing.id },
        data: {
          resolved: c.resolved,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
    }
  }

  await prisma.doc.update({
    where: { id: doc.id },
    data: { commentsLastSyncedAt: new Date() },
  });

  if (doc.mimeType !== DOCS_MIME_TYPE) return created;

  // Docs API sync: ensures ALL pending suggestions are tracked.
  const existingSuggestionIds = new Set(
    (await prisma.comment.findMany({
      where: { docId: doc.id, type: "SUGGESTION" },
      select: { googleCommentId: true },
    })).map((r) => r.googleCommentId)
  );

  const liveDocsIds = new Set<string>();
  for (const s of docsSuggestionsForSync) {
    liveDocsIds.add(s.id);
    await prisma.comment.upsert({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: s.id } },
      create: {
        docId: doc.id,
        googleCommentId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        resolved: false,
        status: "ACTIVE",
        driveCreatedAt: doc.lastModifiedInDrive ?? new Date(),
      },
      update: {
        suggestionType: s.suggestionType,
      },
    });
    if (!existingSuggestionIds.has(s.id)) created++;
  }

  // Mark suggest.xxx suggestions no longer in the document as resolved.
  const activeSuggestions = await prisma.comment.findMany({
    where: { docId: doc.id, type: "SUGGESTION", resolved: false },
  });
  for (const s of activeSuggestions) {
    // Drive API comment IDs starting with "AAAB" are system-generated anchors
    // (e.g. bookmark or heading references), not user suggestions — skip them.
    if (s.googleCommentId.startsWith("AAAB")) continue;
    if (!liveDocsIds.has(s.googleCommentId)) {
      await prisma.comment.update({
        where: { id: s.id },
        data: { resolved: true, status: s.status === "ACTIVE" ? "ARCHIVED" : s.status },
      });
    }
  }

  return created;
}

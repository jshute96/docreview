import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// Syncs all comments and suggestions for a single doc. Always does a full scan —
// Drive API's startModifiedTime filter silently excludes suggestions.
// Returns the number of new comment records created and whether the doc should be unarchived.
export async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>
): Promise<{ created: number; shouldUnarchive: boolean; isDeleted?: boolean; transientError?: boolean }> {
  let comments;
  try {
    comments = await fetchComments(driveAuth, doc.googleDocId);
  } catch (err: any) {
    const code = err?.code;
    if (code === 404 || code === 403) {
      console.log(`[Comments] doc ${doc.googleDocId} is deleted or inaccessible (code ${code})`);
      return { created: 0, shouldUnarchive: false, isDeleted: true };
    }
    console.error(`[Comments] failed for ${doc.googleDocId}:`, err);
    return { created: 0, shouldUnarchive: false, transientError: true };
  }

  // All Drive API results are regular comments. Suggestions come exclusively from Docs API.
  let docsSuggestionsForSync: Awaited<ReturnType<typeof fetchSuggestions>> = [];
  let suggestionFetchFailed = false;
  if (doc.mimeType === DOCS_MIME_TYPE) {
    try {
      docsSuggestionsForSync = await fetchSuggestions(driveAuth, doc.googleDocId);
    } catch (err) {
      console.error(`[Suggestions] fetch failed for ${doc.googleDocId}:`, err);
      suggestionFetchFailed = true;
    }
  }

  let created = 0;
  let shouldUnarchive = false;

  for (const c of comments) {
    const existing = await prisma.comment.findUnique({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: c.id } },
    });

    // Activity is interesting if I'm the doc author or a participant in the thread,
    // unless I resolved it myself.
    const isInteresting = !(c.resolved && c.iResolvedIt) && (
      doc.role === "AUTHOR" || c.iParticipated
    );

    if (!existing) {
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.create({
        data: {
          docId: doc.id,
          googleCommentId: c.id,
          type: "COMMENT",
          resolved: c.resolved,
          isThreadAuthor: c.isThreadAuthor,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
      created++;
      if (isInteresting) shouldUnarchive = true;
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
      // Existing comment with new replies: check for unarchive
      if (c.replyCount > existing.replyCount) {
        // MUTED comments already handled above (early continue), so status is ACTIVE or ARCHIVED here
        if (isInteresting) shouldUnarchive = true;
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

  if (doc.mimeType !== DOCS_MIME_TYPE) return { created, shouldUnarchive };

  // If the Docs API fetch failed, skip suggestion sync entirely — we can't
  // tell which suggestions are still live, so resolving absent ones would be wrong.
  if (suggestionFetchFailed) return { created, shouldUnarchive, transientError: true };

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
    if (!existingSuggestionIds.has(s.id)) {
      created++;
      // New suggestion: unarchive if I'm the doc author (suggestions have
      // isThreadAuthor=false and iParticipated=false)
      if (doc.role === "AUTHOR") shouldUnarchive = true;
    }
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

  return { created, shouldUnarchive };
}

import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

function datesEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

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

  const toCreate: Parameters<typeof prisma.comment.createMany>[0]["data"] = [];
  let updatedCount = 0;
  let shouldUnarchive = false;

  // Batch-fetch all existing comments for this doc to avoid N+1 queries
  const existingComments = new Map(
    (await prisma.comment.findMany({
      where: { docId: doc.id, type: "COMMENT" },
    })).map((c) => [c.googleCommentId, c])
  );

  for (const c of comments) {
    const existing = existingComments.get(c.id) ?? null;

    // Activity is interesting if I'm the doc author or a participant in the thread,
    // unless I resolved it myself.
    const isInteresting = !(c.resolved && c.iResolvedIt) && (
      doc.role === "AUTHOR" || c.iParticipated
    );

    if (!existing) {
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      toCreate.push({
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
      });
      if (isInteresting) shouldUnarchive = true;
    } else {
      if (existing.status === "MUTED") {
        const changed =
          existing.resolved !== c.resolved ||
          existing.iParticipated !== c.iParticipated ||
          !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
          !datesEqual(existing.driveModifiedAt, c.driveModifiedAt) ||
          existing.replyCount !== c.replyCount;
        if (changed) {
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
          updatedCount++;
        }
        continue;
      }
      // Existing comment with new replies: check for unarchive
      if (c.replyCount > existing.replyCount) {
        // MUTED comments already handled above (early continue), so status is ACTIVE or ARCHIVED here
        if (isInteresting) shouldUnarchive = true;
      }
      const status = c.resolved && c.iResolvedIt ? "ARCHIVED" : "ACTIVE";
      const changed =
        existing.resolved !== c.resolved ||
        existing.iParticipated !== c.iParticipated ||
        existing.status !== status ||
        !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
        !datesEqual(existing.driveModifiedAt, c.driveModifiedAt) ||
        existing.replyCount !== c.replyCount;
      if (changed) {
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
        updatedCount++;
      }
    }
  }

  if (toCreate.length > 0) {
    await prisma.comment.createMany({ data: toCreate });
  }
  const created = toCreate.length;

  // Delete comment records that Drive no longer returns (deleted in Google Docs).
  // We don't store comment text, so there's nothing useful left to show.
  const driveCommentIds = new Set(comments.map((c) => c.id));
  const deletedIds = [...existingComments.values()]
    .filter((c) => !driveCommentIds.has(c.googleCommentId))
    .map((c) => c.id);
  let deleted = 0;
  if (deletedIds.length > 0) {
    const result = await prisma.comment.deleteMany({
      where: { id: { in: deletedIds } },
    });
    deleted = result.count;
  }

  await prisma.doc.update({
    where: { id: doc.id },
    data: { commentsLastSyncedAt: new Date() },
  });

  if (doc.mimeType !== DOCS_MIME_TYPE) {
    console.log(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive, ${created} new, ${updatedCount} updated, ${deleted} deleted${shouldUnarchive ? " → unarchive" : ""}`);
    return { created, shouldUnarchive };
  }

  // If the Docs API fetch failed, skip suggestion sync entirely — we can't
  // tell which suggestions are still live, so resolving absent ones would be wrong.
  if (suggestionFetchFailed) {
    console.log(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive, ${created} new, ${updatedCount} updated (suggestions skipped: fetch failed)`);
    return { created, shouldUnarchive, transientError: true };
  }

  // Docs API sync: ensures ALL pending suggestions are tracked.
  const existingSuggestions = new Map(
    (await prisma.comment.findMany({
      where: { docId: doc.id, type: "SUGGESTION" },
      select: { id: true, googleCommentId: true, suggestionType: true },
    })).map((r) => [r.googleCommentId, r])
  );

  const liveDocsIds = new Set<string>();
  const suggestionsToCreate: typeof toCreate = [];
  let suggestionsUpdated = 0;
  for (const s of docsSuggestionsForSync) {
    liveDocsIds.add(s.id);
    const existing = existingSuggestions.get(s.id);
    if (!existing) {
      suggestionsToCreate.push({
        docId: doc.id,
        googleCommentId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        resolved: false,
        status: "ACTIVE",
        driveCreatedAt: doc.lastModifiedInDrive ?? new Date(),
      });
      // New suggestion: unarchive if I'm the doc author (suggestions have
      // isThreadAuthor=false and iParticipated=false)
      if (doc.role === "AUTHOR") shouldUnarchive = true;
    } else if (existing.suggestionType !== s.suggestionType) {
      await prisma.comment.update({
        where: { id: existing.id },
        data: { suggestionType: s.suggestionType },
      });
      suggestionsUpdated++;
    }
  }
  if (suggestionsToCreate.length > 0) {
    await prisma.comment.createMany({ data: suggestionsToCreate });
  }

  // Mark suggest.xxx suggestions no longer in the document as resolved.
  let suggestionsResolved = 0;
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
      suggestionsResolved++;
    }
  }

  const totalCreated = created + suggestionsToCreate.length;
  console.log(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive, ${totalCreated} new, ${updatedCount} updated, ${deleted} deleted; ${docsSuggestionsForSync.length} suggestions (${suggestionsToCreate.length} new, ${suggestionsUpdated} updated, ${suggestionsResolved} resolved)${shouldUnarchive ? " → unarchive" : ""}`);
  return { created: totalCreated, shouldUnarchive };
}

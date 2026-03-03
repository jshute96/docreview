import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import type { Doc, Prisma } from "@prisma/client";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

function datesEqual(a: Date | null | undefined, b: Date | null | undefined): boolean {
  const timeA = a instanceof Date ? a.getTime() : null;
  const timeB = b instanceof Date ? b.getTime() : null;
  return timeA === timeB;
}

// Syncs all comments and suggestions for a single doc. Always does a full scan —
// Drive API's startModifiedTime filter silently excludes suggestions.
// Returns the number of new comment records created, whether the doc should be unarchived,
// and whether there was non-resolve activity (used to suppress unarchive for resolve-only changes).
export async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
  userEmail?: string
): Promise<{ created: number; shouldUnarchive: boolean; hasNonResolveActivity: boolean; isDeleted?: boolean; transientError?: boolean }> {
  let comments;
  try {
    comments = await fetchComments(driveAuth, doc.googleDocId, undefined, userEmail);
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 404 || code === 403) {
      logWarning(`[Comments] doc ${doc.googleDocId} is deleted or inaccessible (code ${code})`);
      return { created: 0, shouldUnarchive: false, hasNonResolveActivity: false, isDeleted: true };
    }
    logError(`[Comments] failed for ${doc.googleDocId}:`, err);
    return { created: 0, shouldUnarchive: false, hasNonResolveActivity: false, transientError: true };
  }

  // All Drive API results are regular comments. Suggestions come exclusively from Docs API.
  let docsSuggestionsForSync: Awaited<ReturnType<typeof fetchSuggestions>> = [];
  let suggestionFetchFailed = false;
  if (doc.mimeType === DOCS_MIME_TYPE) {
    try {
      docsSuggestionsForSync = await fetchSuggestions(driveAuth, doc.googleDocId);
    } catch (err) {
      logError(`[Suggestions] fetch failed for ${doc.googleDocId}:`, err);
      suggestionFetchFailed = true;
    }
  }

  const toCreate: Prisma.CommentCreateManyInput[] = [];
  let updatedCount = 0;
  let shouldUnarchive = false;
  let hasNonResolveActivity = false;

  // Batch-fetch all existing comments for this doc to avoid N+1 queries
  const existingComments = new Map(
    (await prisma.comment.findMany({
      where: { docId: doc.docId, type: "COMMENT" },
    })).map((c) => [c.googleCommentId, c])
  );

  for (const c of comments) {
    const existing = existingComments.get(c.id) ?? null;

    if (!existing) {
      // New comment initial status (spec rules 1-6, first match wins):
      // Rule 2: @-mention of me → INBOX (even if resolved, overrides everything)
      // Rule 4: I'm the doc author → INBOX (if not resolved)
      // Rule 5/6: I participated → INBOX (if not resolved)
      const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
      const status: "INBOX" | "ARCHIVED" = mentionedInThread
        ? "INBOX"
        : c.resolved
          ? "ARCHIVED"
          : (doc.role === "AUTHOR" || c.iParticipated)
            ? "INBOX"
            : "ARCHIVED";

      toCreate.push({
        docId: doc.docId,
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

      // Doc-level unarchive: new comment with INBOX status triggers unarchive
      if (status === "INBOX") shouldUnarchive = true;
      // Track non-resolve activity: unresolved comments or @-mentions (even on resolved)
      if (!c.resolved || mentionedInThread) hasNonResolveActivity = true;
    } else {
      const hasNewReplies = c.replyCount > existing.replyCount;
      const hasNewActivity =
        hasNewReplies ||
        (!existing.resolved && c.resolved) ||
        (existing.resolved && !c.resolved) ||
        !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);

      // Rule 2: @-mention in new replies breaks out of MUTED (spec: "only case
      // when a comment moves out of Muted state").
      const newReplyMentionsMe = hasNewReplies &&
        (c.replyMentionedMeFlags ?? []).slice(existing.replyCount).some(Boolean);

      if (existing.status === "MUTED" && !newReplyMentionsMe) {
        const changed =
          existing.resolved !== c.resolved ||
          existing.iParticipated !== c.iParticipated ||
          !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
          !datesEqual(existing.driveModifiedAt, c.driveModifiedAt) ||
          existing.replyCount !== c.replyCount;
        if (changed) {
          await prisma.comment.update({
            where: { commentId: existing.commentId },
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

      const previousStatus = existing.status as "INBOX" | "ARCHIVED" | "MUTED";

      // Track non-resolve activity for existing comments
      if (hasNewActivity) {
        const isBeingResolved = c.resolved && !existing.resolved;
        const newReplyCount = c.replyCount - existing.replyCount;
        if (isBeingResolved && newReplyCount <= 1) {
          // Resolve-only: exactly 1 new reply (the resolve action) and comment is now resolved
        } else if (existing.resolved && !c.resolved) {
          // Re-opened → non-resolve activity
          hasNonResolveActivity = true;
        } else {
          // New replies beyond a resolve, or other activity
          hasNonResolveActivity = true;
        }
      }

      // Determine the target status using spec rules (first matching rule wins)
      let status: "INBOX" | "ARCHIVED" | "MUTED" = previousStatus;

      if (newReplyMentionsMe) {
        // Rule 2: @-mention in new reply → INBOX (overrides MUTED and all other rules)
        status = "INBOX";
        hasNonResolveActivity = true;
      } else if (c.resolved && c.iResolvedIt) {
        // Rule 1: I resolved it → ARCHIVED
        status = "ARCHIVED";
      } else if (hasNewActivity) {
        if (doc.role === "AUTHOR") {
          // Rule 4: I'm the doc author → INBOX for all activity
          status = "INBOX";
        } else if (c.isThreadAuthor && hasNewReplies) {
          // Rule 5: I started this thread — only INBOX if someone else replied
          const newReplies = c.replyAuthorMeFlags.slice(existing.replyCount);
          const hasReplyFromOther = newReplies.some((me) => !me);
          if (hasReplyFromOther) {
            status = "INBOX";
          }
          // If only self-replies, preserve existing status
        } else if (c.iParticipated && !c.isThreadAuthor) {
          // Rule 6: I participated (replied) on someone else's thread → INBOX
          // No self-reply filtering here: the spec says any activity on a thread
          // I replied on (that I didn't start) moves it to INBOX, including my
          // own follow-up replies. The self-reply exception only applies to
          // threads I started (rule 5).
          status = "INBOX";
        }
        // Otherwise: not relevant to me → preserve existing status
      }

      // Doc-level unarchive rules (based on resulting comment status):
      // 1. Comment transitions from non-INBOX to INBOX
      if (previousStatus !== "INBOX" && status === "INBOX") {
        shouldUnarchive = true;
      }
      // 2. Existing INBOX comment gets new replies (unless I resolved it myself)
      if (previousStatus === "INBOX" && hasNewReplies && !(c.resolved && c.iResolvedIt)) {
        shouldUnarchive = true;
      }
      // 3. INBOX comment resolved by someone else (before we transition it to ARCHIVED via rule 1)
      if (previousStatus === "INBOX" && c.resolved && !c.iResolvedIt) {
        shouldUnarchive = true;
      }

      const changed =
        existing.resolved !== c.resolved ||
        existing.iParticipated !== c.iParticipated ||
        existing.status !== status ||
        !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
        !datesEqual(existing.driveModifiedAt, c.driveModifiedAt) ||
        existing.replyCount !== c.replyCount;
      if (changed) {
        await prisma.comment.update({
          where: { commentId: existing.commentId },
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
    .map((c) => c.commentId);
  let deleted = 0;
  if (deletedIds.length > 0) {
    const result = await prisma.comment.deleteMany({
      where: { commentId: { in: deletedIds } },
    });
    deleted = result.count;
  }

  await prisma.doc.update({
    where: { docId: doc.docId },
    data: { commentsLastSyncedAt: new Date() },
  });

  if (doc.mimeType !== DOCS_MIME_TYPE) {
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive, ${created} new, ${updatedCount} updated, ${deleted} deleted${shouldUnarchive ? " → unarchive" : ""}`);
    return { created, shouldUnarchive, hasNonResolveActivity };
  }

  // If the Docs API fetch failed, skip suggestion sync entirely — we can't
  // tell which suggestions are still live, so resolving absent ones would be wrong.
  if (suggestionFetchFailed) {
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive, ${created} new, ${updatedCount} updated (suggestions skipped: fetch failed)`);
    return { created, shouldUnarchive, hasNonResolveActivity, transientError: true };
  }

  // Docs API sync: ensures ALL pending suggestions are tracked.
  const existingSuggestions = new Map(
    (await prisma.comment.findMany({
      where: { docId: doc.docId, type: "SUGGESTION" },
      select: { commentId: true, googleCommentId: true, suggestionType: true },
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
        docId: doc.docId,
        googleCommentId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        resolved: false,
        status: "INBOX",
        driveCreatedAt: doc.lastModifiedInDrive ?? new Date(),
      });
      // New suggestion: unarchive if I'm the doc author (suggestions have
      // isThreadAuthor=false and iParticipated=false)
      if (doc.role === "AUTHOR") shouldUnarchive = true;
      hasNonResolveActivity = true;
    } else if (existing.suggestionType !== s.suggestionType) {
      await prisma.comment.update({
        where: { commentId: existing.commentId },
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
    where: { docId: doc.docId, type: "SUGGESTION", resolved: false },
  });
  for (const s of activeSuggestions) {
    // Drive API comment IDs starting with "AAAB" are system-generated anchors
    // (e.g. bookmark or heading references), not user suggestions — skip them.
    if (s.googleCommentId.startsWith("AAAB")) continue;
    if (!liveDocsIds.has(s.googleCommentId)) {
      await prisma.comment.update({
        where: { commentId: s.commentId },
        data: { resolved: true, status: s.status === "INBOX" ? "ARCHIVED" : s.status },
      });
      suggestionsResolved++;
    }
  }

  const totalCreated = created + suggestionsToCreate.length;
  logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive, ${totalCreated} new, ${updatedCount} updated, ${deleted} deleted; ${docsSuggestionsForSync.length} suggestions (${suggestionsToCreate.length} new, ${suggestionsUpdated} updated, ${suggestionsResolved} resolved)${shouldUnarchive ? " → unarchive" : ""}`);
  return { created: totalCreated, shouldUnarchive, hasNonResolveActivity };
}

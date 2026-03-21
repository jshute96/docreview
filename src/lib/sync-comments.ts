import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { computeSuggestionHash } from "@/lib/suggestion-hash";
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
): Promise<{
  commentsCreated: number;
  commentsUpdated: number;
  suggestionsCreated: number;
  suggestionsUpdated: number;
  suggestionsResolved: number;
  shouldUnarchive: boolean;
  hasNonResolveActivity: boolean;
  isDeleted?: boolean;
  permissionDenied?: boolean;
  transientError?: boolean;
}> {
  // Record sync start time BEFORE fetching — any changes that arrive during
  // the sync will have timestamps after this, ensuring the next sync covers them.
  const syncStartedAt = new Date();

  let comments;
  try {
    comments = await fetchComments(driveAuth, doc.googleDocId, undefined, userEmail);
  } catch (err: any) {
    const code = err.code;
    if (code === 404) {
      logWarning(`[Comments] doc ${doc.googleDocId} not found (code 404)`);
      return {
        commentsCreated: 0, commentsUpdated: 0,
        suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
        shouldUnarchive: false, hasNonResolveActivity: false, isDeleted: true
      };
    }
    if (code === 403) {
      logWarning(`[Comments] permission denied for ${doc.googleDocId} (code 403)`);
      // Stamp so we don't retry every refresh — permissions rarely change,
      // and if they do, lastModifiedInDrive will update to trigger a re-sync.
      await prisma.doc.update({
        where: { docId: doc.docId },
        data: { commentsLastSyncedAt: syncStartedAt },
      });
      return {
        commentsCreated: 0, commentsUpdated: 0,
        suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
        shouldUnarchive: false, hasNonResolveActivity: false, permissionDenied: true
      };
    }
    logError(`[Comments] failed for ${doc.googleDocId}:`, err);
    return {
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false, transientError: true
    };
  }

  // All Drive API results are regular comments. Suggestions come exclusively from Docs API.
  let docsSuggestionsForSync: Awaited<ReturnType<typeof fetchSuggestions>> = [];
  let suggestionFetchFailed = false;
  let suggestionPermissionDenied = false;
  if (doc.mimeType === DOCS_MIME_TYPE) {
    try {
      docsSuggestionsForSync = await fetchSuggestions(driveAuth, doc.googleDocId);
    } catch (err: any) {
      if (
        err.code === 403 &&
        err.message?.includes("permission to access the document suggestions")
      ) {
        logWarning(`[Suggestions:Docs] permission denied for ${doc.googleDocId}`);
        suggestionPermissionDenied = true;
      } else {
        logError(`[Suggestions:Docs] fetch failed for ${doc.googleDocId}:`, err);
        suggestionFetchFailed = true;
      }
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
      // Rule 5/6: I participated (authored or replied) → INBOX (if not resolved)
      const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
      const status: "INBOX" | "ARCHIVED" = mentionedInThread
        ? "INBOX"
        : c.resolved
          ? "ARCHIVED"
          : (doc.role === "AUTHOR" || c.isThreadAuthor || c.isReplyAuthor)
            ? "INBOX"
            : "ARCHIVED";

      toCreate.push({
        docId: doc.docId,
        googleCommentId: c.id,
        type: "COMMENT",
        resolved: c.resolved,
        isThreadAuthor: c.isThreadAuthor,
        isReplyAuthor: c.isReplyAuthor,
        isRead: c.isRead,
        assignedToMe: c.assignedToMe,
        mentionedMe: mentionedInThread,
        mentionedMeUnreplied: c.mentionedMeUnreplied,
        status,
        driveCreatedAt: c.driveCreatedAt,
        driveModifiedAt: c.driveModifiedAt,
        replyCount: c.replyCount,
      });

      // Doc-level unarchive: new comment with INBOX status triggers unarchive,
      // but not if the comment is already read (I'm the last commenter — my own
      // activity shouldn't resurface an archived doc).
      if (status === "INBOX" && !c.isRead) shouldUnarchive = true;
      // Track non-resolve activity: unresolved comments or @-mentions (even on resolved)
      if ((!c.resolved || mentionedInThread) && !c.isRead) hasNonResolveActivity = true;
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
        // Only update isRead from Drive when driveModifiedAt changed (new activity)
        const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
        const effectiveIsRead = modifiedChanged ? c.isRead : existing.isRead;
        const mentionedInThreadMuted = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
        const changed =
          existing.resolved !== c.resolved ||
          existing.isReplyAuthor !== c.isReplyAuthor ||
          existing.isRead !== effectiveIsRead ||
          existing.assignedToMe !== c.assignedToMe ||
          existing.mentionedMe !== mentionedInThreadMuted ||
          existing.mentionedMeUnreplied !== c.mentionedMeUnreplied ||
          !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
          modifiedChanged ||
          existing.replyCount !== c.replyCount;
        if (changed) {
          await prisma.comment.update({
            where: { commentId: existing.commentId },
            data: {
              resolved: c.resolved,
              isReplyAuthor: c.isReplyAuthor,
              isRead: effectiveIsRead,
              assignedToMe: c.assignedToMe,
              mentionedMe: mentionedInThreadMuted,
              mentionedMeUnreplied: c.mentionedMeUnreplied,
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

      // Track non-resolve activity for existing comments.
      // Skip when isRead — my own activity shouldn't resurface an archived doc.
      if (hasNewActivity && !c.isRead) {
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
        // @-mention always counts as activity even if isRead (someone explicitly asked for my attention)
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
        } else if (c.isReplyAuthor && !c.isThreadAuthor) {
          // Rule 6: I participated (replied) on someone else's thread → INBOX
          // No self-reply filtering here: the spec says any activity on a thread
          // I replied on (that I didn't start) moves it to INBOX, including my
          // own follow-up replies. The self-reply exception only applies to
          // threads I started (rule 5).
          status = "INBOX";
        }
        // Otherwise: not relevant to me → preserve existing status
      }

      // Doc-level unarchive rules (based on resulting comment status).
      // All gated on !c.isRead: my own activity shouldn't resurface an archived doc.
      if (!c.isRead) {
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
      }

      // Only update isRead from Drive when driveModifiedAt changed (new activity)
      const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
      const effectiveIsRead = modifiedChanged ? c.isRead : existing.isRead;
      const mentionedInThreadUpdate = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
      const changed =
        existing.resolved !== c.resolved ||
        existing.isReplyAuthor !== c.isReplyAuthor ||
        existing.isRead !== effectiveIsRead ||
        existing.assignedToMe !== c.assignedToMe ||
        existing.mentionedMe !== mentionedInThreadUpdate ||
        existing.mentionedMeUnreplied !== c.mentionedMeUnreplied ||
        existing.status !== status ||
        !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
        modifiedChanged ||
        existing.replyCount !== c.replyCount;
      if (changed) {
        await prisma.comment.update({
          where: { commentId: existing.commentId },
          data: {
            resolved: c.resolved,
            isReplyAuthor: c.isReplyAuthor,
            isRead: effectiveIsRead,
            assignedToMe: c.assignedToMe,
            mentionedMe: mentionedInThreadUpdate,
            mentionedMeUnreplied: c.mentionedMeUnreplied,
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
    .filter((c) => !c.googleCommentId || !driveCommentIds.has(c.googleCommentId))
    .map((c) => c.commentId);
  let deleted = 0;
  if (deletedIds.length > 0) {
    const result = await prisma.comment.deleteMany({
      where: { commentId: { in: deletedIds } },
    });
    deleted = result.count;
  }

  if (doc.mimeType !== DOCS_MIME_TYPE) {
    // No suggestions to sync — stamp and return
    await prisma.doc.update({
      where: { docId: doc.docId },
      data: { commentsLastSyncedAt: syncStartedAt },
    });
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${created} new, ${updatedCount} updated, ${deleted} deleted)${shouldUnarchive ? " → unarchive" : ""}`);
    return {
      commentsCreated: created,
      commentsUpdated: updatedCount,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive,
      hasNonResolveActivity
    };
  }

  // If the Docs API fetch failed, skip suggestion sync entirely — we can't
  // tell which suggestions are still live, so resolving absent ones would be wrong.
  if (suggestionFetchFailed) {
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${created} new, ${updatedCount} updated) (suggestions skipped: fetch failed)`);
    return {
      commentsCreated: created,
      commentsUpdated: updatedCount,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive,
      hasNonResolveActivity,
      transientError: true
    };
  }

  if (suggestionPermissionDenied) {
    // Comments synced successfully; suggestions denied (common for view-only docs).
    // Stamp so we don't retry every refresh.
    await prisma.doc.update({
      where: { docId: doc.docId },
      data: { commentsLastSyncedAt: syncStartedAt },
    });
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${created} new, ${updatedCount} updated) (suggestions skipped: permission denied)`);
    return {
      commentsCreated: created,
      commentsUpdated: updatedCount,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive,
      hasNonResolveActivity,
      permissionDenied: true
    };
  }

  // Docs API sync: ensures ALL pending suggestions are tracked.
  // Build lookup maps: by googleSuggestionId (primary) and by content hash (fallback
  // for Gmail-first rows that don't have a googleSuggestionId yet).
  const allExistingSuggestions = await prisma.comment.findMany({
    where: { docId: doc.docId, type: "SUGGESTION" },
    select: { commentId: true, googleSuggestionId: true, suggestionType: true, suggestionContentHash: true },
  });
  const byGoogleSuggestionId = new Map(
    allExistingSuggestions
      .filter((r) => r.googleSuggestionId)
      .map((r) => [r.googleSuggestionId!, r])
  );
  // Hash map: only include rows without a googleSuggestionId (Gmail-first rows).
  // Rows with a googleSuggestionId are already found by the primary lookup.
  const byContentHash = new Map<string, typeof allExistingSuggestions>();
  for (const r of allExistingSuggestions) {
    if (r.googleSuggestionId || !r.suggestionContentHash) continue;
    const list = byContentHash.get(r.suggestionContentHash) ?? [];
    list.push(r);
    byContentHash.set(r.suggestionContentHash, list);
  }

  const liveDocsIds = new Set<string>();
  const suggestionsToCreate: typeof toCreate = [];
  let suggestionsUpdated = 0;
  for (const s of docsSuggestionsForSync) {
    liveDocsIds.add(s.id);
    const contentHash = computeSuggestionHash(s.suggestionType, s.deletedText, s.insertedText);

    // Primary lookup by suggestion ID, then fallback to unique content hash match
    let existing = byGoogleSuggestionId.get(s.id) ?? null;
    if (!existing) {
      const hashCandidates = byContentHash.get(contentHash);
      if (hashCandidates?.length === 1) {
        existing = hashCandidates[0];
      } else if (hashCandidates && hashCandidates.length > 1) {
        logWarning(`[Suggestions:Docs] ${doc.googleDocId}: multiple hash matches for ${s.id} — inserting new row`);
      }
    }

    if (!existing) {
      suggestionsToCreate.push({
        docId: doc.docId,
        googleSuggestionId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        suggestionContentHash: contentHash,
        resolved: false,
        status: "INBOX",
        driveCreatedAt: doc.lastModifiedInDrive ?? new Date(),
      });
      // New suggestion: unarchive if I'm the doc author (suggestions have
      // isThreadAuthor=false and isReplyAuthor=false)
      if (doc.role === "AUTHOR") shouldUnarchive = true;
      hasNonResolveActivity = true;
    } else {
      // Update fields that may have changed or been missing (e.g., Gmail-first row
      // that needs googleSuggestionId filled in by Drive sync)
      const needsSuggestionId = !existing.googleSuggestionId;
      const typeChanged = existing.suggestionType !== s.suggestionType;
      const hashChanged = existing.suggestionContentHash !== contentHash;
      if (needsSuggestionId) {
        logInfo(`[Suggestions:Docs] ${doc.googleDocId}: adopted Gmail-first row ${existing.commentId} → ${s.id}`);
      }
      if (needsSuggestionId || typeChanged || hashChanged) {
        await prisma.comment.update({
          where: { commentId: existing.commentId },
          data: {
            ...(needsSuggestionId ? { googleSuggestionId: s.id } : {}),
            ...(typeChanged ? { suggestionType: s.suggestionType } : {}),
            ...(hashChanged ? { suggestionContentHash: contentHash } : {}),
          },
        });
        suggestionsUpdated++;
      }
    }
  }
  if (suggestionsToCreate.length > 0) {
    await prisma.comment.createMany({ data: suggestionsToCreate });
  }

  // Mark suggestions no longer in the document as resolved.
  let suggestionsResolved = 0;
  const activeSuggestions = await prisma.comment.findMany({
    where: { docId: doc.docId, type: "SUGGESTION", resolved: false },
  });
  for (const s of activeSuggestions) {
    if (!s.googleSuggestionId || !liveDocsIds.has(s.googleSuggestionId)) {
      await prisma.comment.update({
        where: { commentId: s.commentId },
        data: { resolved: true, status: s.status === "INBOX" ? "ARCHIVED" : s.status },
      });
      suggestionsResolved++;
    }
  }

  const suggestionsCreated = suggestionsToCreate.length;

  // Both comments and suggestions synced successfully — stamp with the time
  // we started the sync so any changes arriving during the sync are covered next time.
  await prisma.doc.update({
    where: { docId: doc.docId },
    data: { commentsLastSyncedAt: syncStartedAt },
  });

  logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive (${created} new, ${updatedCount} updated, ${deleted} deleted); ${docsSuggestionsForSync.length} suggestions (${suggestionsCreated} new, ${suggestionsUpdated} updated, ${suggestionsResolved} resolved)${shouldUnarchive ? " → unarchive" : ""}`);
  return {
    commentsCreated: created,
    commentsUpdated: updatedCount,
    suggestionsCreated,
    suggestionsUpdated,
    suggestionsResolved,
    shouldUnarchive,
    hasNonResolveActivity
  };
}

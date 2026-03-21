import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions, getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { computeSuggestionHash } from "@/lib/suggestion-hash";
import type { Doc, Comment, Prisma } from "@prisma/client";
import type { DriveSuggestion } from "@/lib/google-drive";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// --- Result type ---

interface SyncResult {
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
}

const EMPTY_RESULT: SyncResult = {
  commentsCreated: 0, commentsUpdated: 0,
  suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
  shouldUnarchive: false, hasNonResolveActivity: false,
};

// --- Helpers ---

function datesEqual(a: Date | null | undefined, b: Date | null | undefined): boolean {
  const timeA = a instanceof Date ? a.getTime() : null;
  const timeB = b instanceof Date ? b.getTime() : null;
  return timeA === timeB;
}

// Drive comment as returned by fetchComments — just the fields we use here.
type DriveComment = Awaited<ReturnType<typeof fetchComments>>[number];

// --- Main entry point ---

/**
 * Syncs all comments and suggestions for a single doc. Always does a full scan —
 * Drive API's startModifiedTime filter silently excludes suggestions.
 *
 * Flow:
 *   1. Fetch comments from Drive API and suggestions from Docs API
 *   2. Upsert comments: create new, update existing (status rules, unarchive signals)
 *   3. Delete comments removed from Drive
 *   4. Upsert suggestions: match by googleSuggestionId or content hash fallback
 *   5. Resolve suggestions no longer in the document
 *   6. Stamp commentsLastSyncedAt
 */
export async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
  userEmail?: string
): Promise<SyncResult> {
  // Record sync start time BEFORE fetching — any changes that arrive during
  // the sync will have timestamps after this, ensuring the next sync covers them.
  const syncStartedAt = new Date();

  // --- Phase 1: Fetch from APIs ---

  const commentsOrError = await fetchDriveComments(doc, driveAuth, syncStartedAt, userEmail);
  if (!Array.isArray(commentsOrError)) return commentsOrError; // error result
  const comments = commentsOrError;

  const { suggestions: docsSuggestions, failed: suggestionFetchFailed, denied: suggestionPermissionDenied } =
    await fetchDocsSuggestions(doc, driveAuth);

  // --- Phase 2: Sync comments from Drive ---

  const commentResult = await syncDriveComments(doc, comments);

  // --- Phase 3: Sync suggestions from Docs API ---
  // (only for Google Docs, and only if the suggestion fetch succeeded)

  if (doc.mimeType !== DOCS_MIME_TYPE) {
    await stampSyncTime(doc.docId, syncStartedAt);
    logCommentSummary(doc, comments.length, commentResult);
    return { ...EMPTY_RESULT, ...commentResult };
  }

  if (suggestionFetchFailed) {
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated) (suggestions skipped: fetch failed)`);
    return { ...EMPTY_RESULT, ...commentResult, transientError: true };
  }

  if (suggestionPermissionDenied) {
    await stampSyncTime(doc.docId, syncStartedAt);
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated) (suggestions skipped: permission denied)`);
    return { ...EMPTY_RESULT, ...commentResult, permissionDenied: true };
  }

  const suggestionResult = await syncDocsSuggestions(doc, docsSuggestions);

  await stampSyncTime(doc.docId, syncStartedAt);

  logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated, ${commentResult.commentsDeleted} deleted); ${docsSuggestions.length} suggestions (${suggestionResult.suggestionsCreated} new, ${suggestionResult.suggestionsUpdated} updated, ${suggestionResult.suggestionsResolved} resolved)${commentResult.shouldUnarchive || suggestionResult.shouldUnarchive ? " → unarchive" : ""}`);

  return {
    commentsCreated: commentResult.commentsCreated,
    commentsUpdated: commentResult.commentsUpdated,
    ...suggestionResult,
    shouldUnarchive: commentResult.shouldUnarchive || suggestionResult.shouldUnarchive,
    hasNonResolveActivity: commentResult.hasNonResolveActivity || suggestionResult.hasNonResolveActivity,
  };
}

// --- Phase 1: Fetch from APIs ---

/**
 * Fetches all comments from the Drive API. Returns the comment array on success,
 * or a SyncResult on error (404/403/transient).
 */
async function fetchDriveComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
  syncStartedAt: Date,
  userEmail?: string,
): Promise<DriveComment[] | SyncResult> {
  try {
    return await fetchComments(driveAuth, doc.googleDocId, undefined, userEmail);
  } catch (err: any) {
    const code = err.code;
    if (code === 404) {
      logWarning(`[Comments] doc ${doc.googleDocId} not found (code 404)`);
      return { ...EMPTY_RESULT, isDeleted: true };
    }
    if (code === 403) {
      logWarning(`[Comments] permission denied for ${doc.googleDocId} (code 403)`);
      // Stamp so we don't retry every refresh — permissions rarely change,
      // and if they do, lastModifiedInDrive will update to trigger a re-sync.
      await stampSyncTime(doc.docId, syncStartedAt);
      return { ...EMPTY_RESULT, permissionDenied: true };
    }
    logError(`[Comments] failed for ${doc.googleDocId}:`, err);
    return { ...EMPTY_RESULT, transientError: true };
  }
}

/**
 * Fetches suggestions from the Docs API (only for Google Docs).
 * Returns the suggestions array and error flags.
 */
async function fetchDocsSuggestions(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
): Promise<{ suggestions: DriveSuggestion[]; failed: boolean; denied: boolean }> {
  if (doc.mimeType !== DOCS_MIME_TYPE) {
    return { suggestions: [], failed: false, denied: false };
  }
  try {
    const suggestions = await fetchSuggestions(driveAuth, doc.googleDocId);
    return { suggestions, failed: false, denied: false };
  } catch (err: any) {
    if (err.code === 403 && err.message?.includes("permission to access the document suggestions")) {
      logWarning(`[Suggestions:Docs] permission denied for ${doc.googleDocId}`);
      return { suggestions: [], failed: false, denied: true };
    }
    logError(`[Suggestions:Docs] fetch failed for ${doc.googleDocId}:`, err);
    return { suggestions: [], failed: true, denied: false };
  }
}

// --- Phase 2: Sync comments ---

interface CommentSyncResult {
  commentsCreated: number;
  commentsUpdated: number;
  commentsDeleted: number;
  shouldUnarchive: boolean;
  hasNonResolveActivity: boolean;
}

/**
 * Upserts Drive comments into the DB and deletes removed ones.
 *
 * For new comments, determines initial status using spec rules (mention → INBOX,
 * resolved → ARCHIVED, author/participant → INBOX, otherwise ARCHIVED).
 *
 * For existing comments, updates metadata and computes status transitions.
 * MUTED comments get a fast-path update that preserves their status unless
 * an @-mention in a new reply breaks them out.
 */
async function syncDriveComments(
  doc: Doc,
  comments: DriveComment[],
): Promise<CommentSyncResult> {
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
      const { record, unarchive, nonResolveActivity } = buildNewComment(doc, c);
      toCreate.push(record);
      if (unarchive) shouldUnarchive = true;
      if (nonResolveActivity) hasNonResolveActivity = true;
    } else {
      const result = await updateExistingComment(doc, c, existing);
      if (result.updated) updatedCount++;
      if (result.unarchive) shouldUnarchive = true;
      if (result.nonResolveActivity) hasNonResolveActivity = true;
    }
  }

  if (toCreate.length > 0) {
    await prisma.comment.createMany({ data: toCreate });
  }

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

  return {
    commentsCreated: toCreate.length,
    commentsUpdated: updatedCount,
    commentsDeleted: deleted,
    shouldUnarchive,
    hasNonResolveActivity,
  };
}

/**
 * Builds a new comment record and determines its initial status.
 * Status rules (first match wins):
 *   Rule 2: @-mention → INBOX (even if resolved)
 *   Rule 4: I'm the doc author → INBOX (if not resolved)
 *   Rule 5/6: I participated (authored or replied) → INBOX (if not resolved)
 *   Otherwise: ARCHIVED
 */
function buildNewComment(
  doc: Doc,
  c: DriveComment,
): { record: Prisma.CommentCreateManyInput; unarchive: boolean; nonResolveActivity: boolean } {
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
  const status: "INBOX" | "ARCHIVED" = mentionedInThread
    ? "INBOX"
    : c.resolved
      ? "ARCHIVED"
      : (doc.role === "AUTHOR" || c.isThreadAuthor || c.isReplyAuthor)
        ? "INBOX"
        : "ARCHIVED";

  const record: Prisma.CommentCreateManyInput = {
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
  };

  // Doc-level unarchive: new INBOX comment triggers unarchive, but not if
  // already read (my own activity shouldn't resurface an archived doc).
  const unarchive = status === "INBOX" && !c.isRead;
  // Track non-resolve activity: unresolved comments or @-mentions (even on resolved)
  const nonResolveActivity = (!c.resolved || mentionedInThread) && !c.isRead;

  return { record, unarchive, nonResolveActivity };
}

/**
 * Updates an existing comment with new data from Drive.
 * Handles MUTED fast-path, status transitions, and unarchive signals.
 */
async function updateExistingComment(
  doc: Doc,
  c: DriveComment,
  existing: Comment,
): Promise<{ updated: boolean; unarchive: boolean; nonResolveActivity: boolean }> {
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

  // MUTED fast-path: update metadata but preserve MUTED status unless @-mentioned
  if (existing.status === "MUTED" && !newReplyMentionsMe) {
    const updated = await updateCommentFields(existing, c);
    return { updated, unarchive: false, nonResolveActivity: false };
  }

  const previousStatus = existing.status as "INBOX" | "ARCHIVED" | "MUTED";
  let nonResolveActivity = false;

  // Track non-resolve activity for existing comments.
  // Skip when isRead — my own activity shouldn't resurface an archived doc.
  if (hasNewActivity && !c.isRead) {
    const isBeingResolved = c.resolved && !existing.resolved;
    const newReplyCount = c.replyCount - existing.replyCount;
    if (isBeingResolved && newReplyCount <= 1) {
      // Resolve-only: exactly 1 new reply (the resolve action) and comment is now resolved
    } else {
      nonResolveActivity = true;
    }
  }

  // Determine the target status using spec rules (first matching rule wins)
  const status = computeCommentStatus(doc, c, existing, previousStatus, hasNewActivity, hasNewReplies, newReplyMentionsMe);

  if (newReplyMentionsMe) {
    // @-mention always counts as activity even if isRead
    nonResolveActivity = true;
  }

  // Doc-level unarchive rules. All gated on !c.isRead.
  let unarchive = false;
  if (!c.isRead) {
    // 1. Comment transitions from non-INBOX to INBOX
    if (previousStatus !== "INBOX" && status === "INBOX") unarchive = true;
    // 2. Existing INBOX comment gets new replies (unless I resolved it myself)
    if (previousStatus === "INBOX" && hasNewReplies && !(c.resolved && c.iResolvedIt)) unarchive = true;
    // 3. INBOX comment resolved by someone else
    if (previousStatus === "INBOX" && c.resolved && !c.iResolvedIt) unarchive = true;
  }

  // Only update isRead from Drive when driveModifiedAt changed (new activity)
  const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
  const effectiveIsRead = modifiedChanged ? c.isRead : existing.isRead;
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);

  const changed =
    existing.resolved !== c.resolved ||
    existing.isReplyAuthor !== c.isReplyAuthor ||
    existing.isRead !== effectiveIsRead ||
    existing.assignedToMe !== c.assignedToMe ||
    existing.mentionedMe !== mentionedInThread ||
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
        mentionedMe: mentionedInThread,
        mentionedMeUnreplied: c.mentionedMeUnreplied,
        status,
        driveCreatedAt: c.driveCreatedAt,
        driveModifiedAt: c.driveModifiedAt,
        replyCount: c.replyCount,
      },
    });
  }

  return { updated: changed, unarchive, nonResolveActivity };
}

/**
 * Determines a comment's target status based on spec rules (first match wins):
 *   Rule 2: @-mention in new reply → INBOX (overrides MUTED)
 *   Rule 1: I resolved it → ARCHIVED
 *   Rule 4: I'm the doc author → INBOX
 *   Rule 5: I started the thread, someone else replied → INBOX
 *   Rule 6: I participated on someone else's thread → INBOX
 */
function computeCommentStatus(
  doc: Doc,
  c: DriveComment,
  existing: Comment,
  previousStatus: "INBOX" | "ARCHIVED" | "MUTED",
  hasNewActivity: boolean,
  hasNewReplies: boolean,
  newReplyMentionsMe: boolean,
): "INBOX" | "ARCHIVED" | "MUTED" {
  if (newReplyMentionsMe) return "INBOX";
  if (c.resolved && c.iResolvedIt) return "ARCHIVED";

  if (hasNewActivity) {
    if (doc.role === "AUTHOR") return "INBOX";
    if (c.isThreadAuthor && hasNewReplies) {
      // Only INBOX if someone else replied (not just my own self-replies)
      const newReplies = c.replyAuthorMeFlags.slice(existing.replyCount);
      if (newReplies.some((me) => !me)) return "INBOX";
    } else if (c.isReplyAuthor && !c.isThreadAuthor) {
      // I participated on someone else's thread — any activity → INBOX
      return "INBOX";
    }
  }

  return previousStatus;
}

/**
 * Updates a MUTED comment's metadata without changing its status.
 * Returns true if any fields were actually changed.
 */
async function updateCommentFields(existing: Comment, c: DriveComment): Promise<boolean> {
  const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
  const effectiveIsRead = modifiedChanged ? c.isRead : existing.isRead;
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);

  const changed =
    existing.resolved !== c.resolved ||
    existing.isReplyAuthor !== c.isReplyAuthor ||
    existing.isRead !== effectiveIsRead ||
    existing.assignedToMe !== c.assignedToMe ||
    existing.mentionedMe !== mentionedInThread ||
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
        mentionedMe: mentionedInThread,
        mentionedMeUnreplied: c.mentionedMeUnreplied,
        driveCreatedAt: c.driveCreatedAt,
        driveModifiedAt: c.driveModifiedAt,
        replyCount: c.replyCount,
      },
    });
  }

  return changed;
}

// --- Phase 3: Sync suggestions ---

interface SuggestionSyncResult {
  suggestionsCreated: number;
  suggestionsUpdated: number;
  suggestionsResolved: number;
  shouldUnarchive: boolean;
  hasNonResolveActivity: boolean;
}

/**
 * Upserts suggestions from the Docs API and resolves absent ones.
 *
 * Lookup order:
 *   1. By googleSuggestionId (primary — matches Drive-created rows)
 *   2. By content hash fallback (matches Gmail-first rows that lack a suggestionId)
 *
 * After upserting, any unresolved suggestion rows NOT in the live set are marked
 * resolved. This includes Gmail-first rows that couldn't be matched by hash.
 */
async function syncDocsSuggestions(
  doc: Doc,
  docsSuggestions: DriveSuggestion[],
): Promise<SuggestionSyncResult> {
  // Build lookup maps: by googleSuggestionId (primary) and by content hash
  // (fallback for Gmail-first rows that don't have a googleSuggestionId yet).
  const allExisting = await prisma.comment.findMany({
    where: { docId: doc.docId, type: "SUGGESTION" },
    select: { commentId: true, googleSuggestionId: true, suggestionType: true, suggestionContentHash: true },
  });

  const byGoogleSuggestionId = new Map(
    allExisting
      .filter((r) => r.googleSuggestionId)
      .map((r) => [r.googleSuggestionId!, r])
  );

  // Hash map: only include rows without a googleSuggestionId (Gmail-first rows).
  // Rows with a googleSuggestionId are already found by the primary lookup.
  const byContentHash = new Map<string, typeof allExisting>();
  for (const r of allExisting) {
    if (r.googleSuggestionId || !r.suggestionContentHash) continue;
    const list = byContentHash.get(r.suggestionContentHash) ?? [];
    list.push(r);
    byContentHash.set(r.suggestionContentHash, list);
  }

  // Upsert live suggestions
  const liveIds = new Set<string>();
  const toCreate: Prisma.CommentCreateManyInput[] = [];
  let updated = 0;
  let shouldUnarchive = false;
  let hasNonResolveActivity = false;

  for (const s of docsSuggestions) {
    liveIds.add(s.id);
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
      toCreate.push({
        docId: doc.docId,
        googleSuggestionId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        suggestionContentHash: contentHash,
        resolved: false,
        status: "INBOX",
        driveCreatedAt: doc.lastModifiedInDrive ?? new Date(),
      });
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
        updated++;
      }
    }
  }

  if (toCreate.length > 0) {
    await prisma.comment.createMany({ data: toCreate });
  }

  // Resolve suggestions no longer in the document (accepted or rejected).
  // Gmail-first rows without a googleSuggestionId are also resolved here —
  // if Drive couldn't match them to a live suggestion, they should be hidden.
  let resolved = 0;
  const activeSuggestions = await prisma.comment.findMany({
    where: { docId: doc.docId, type: "SUGGESTION", resolved: false },
  });
  for (const s of activeSuggestions) {
    if (!s.googleSuggestionId || !liveIds.has(s.googleSuggestionId)) {
      await prisma.comment.update({
        where: { commentId: s.commentId },
        data: { resolved: true, status: s.status === "INBOX" ? "ARCHIVED" : s.status },
      });
      resolved++;
    }
  }

  return {
    suggestionsCreated: toCreate.length,
    suggestionsUpdated: updated,
    suggestionsResolved: resolved,
    shouldUnarchive,
    hasNonResolveActivity,
  };
}

// --- Utilities ---

async function stampSyncTime(docId: string, syncStartedAt: Date) {
  await prisma.doc.update({
    where: { docId },
    data: { commentsLastSyncedAt: syncStartedAt },
  });
}

function logCommentSummary(doc: Doc, commentCount: number, result: CommentSyncResult) {
  logInfo(`[Comments] ${doc.googleDocId}: ${commentCount} from Drive (${result.commentsCreated} new, ${result.commentsUpdated} updated, ${result.commentsDeleted} deleted)${result.shouldUnarchive ? " → unarchive" : ""}`);
}

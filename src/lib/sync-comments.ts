import { prisma } from "@/lib/prisma";
import { fetchCommentData, fetchDocData, fetchThreadDetail, getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { computeSuggestionHash } from "@/lib/suggestion-hash";
import type { Doc, Comment, Prisma, CommentStatus } from "@prisma/client";
import type { DriveComment, DriveSuggestion, CommentThread, ThreadDetailResult } from "@/lib/google-drive";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

// Extract Prisma's interactive-transaction client type from $transaction's callback signature.
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Bumps a doc's lastCommentActivity to the max of its current value and the
 * given timestamps via raw SQL GREATEST. Accepts an optional transaction client
 * so the bump can run in the same transaction as the comment write. Returns the
 * number of affected rows (0 or 1). After comment deletions the value may
 * exceed any current comment's timestamp — this is intentional (there WAS
 * activity at that time).
 */
export async function bumpLastCommentActivity(
  docId: string,
  timestamps: (Date | null | undefined)[],
  tx?: TxClient,
): Promise<number> {
  const valid = timestamps.filter((t): t is Date => t instanceof Date);
  if (valid.length === 0) return 0;
  const max = new Date(Math.max(...valid.map(t => t.getTime())));
  const client = tx ?? prisma;
  // The column is TIMESTAMP (without tz). Prisma stores all dates as UTC in
  // these columns. $executeRaw with a Date object converts to local time, so
  // we pass the ISO string cast as ::timestamp to store the UTC value as-is.
  const maxIso = max.toISOString();
  return client.$executeRaw`
    UPDATE docs SET last_comment_activity = GREATEST(last_comment_activity, ${maxIso}::timestamp)
    WHERE doc_id = ${docId}
  `;
}

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
  /** Thread display data from single-comment sync, so callers can pass it
   *  to the client without a redundant Drive API fetch. */
  thread?: CommentThread;
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
/** Optional pre-fetched data to avoid redundant API calls during single-doc refresh. */
export interface SyncPrefetchedData {
  comments?: DriveComment[];
  suggestions?: DriveSuggestion[];
}

/**
 * Optional hints from the Chrome extension telling us which specific action
 * the user just took. Allows skipping irrelevant API calls and fetching only
 * the affected comment instead of all comments.
 */
export interface SyncHints {
  /** 'comment' for actions on comment threads, 'suggestion' for actions on suggestion threads. */
  commentType?: string;
  /** Google Drive comment ID (disco ID) — fetch only this comment instead of all. */
  googleCommentId?: string;
}

// --- Single-comment sync ---

/** Result of syncing a single comment from Drive. */
export interface SingleCommentResult {
  comment: Comment | null;   // updated/created DB record, null if deleted
  thread?: CommentThread;    // display data for the thread panel
  created: boolean;
  updated: boolean;
  deleted: boolean;
  shouldUnarchive: boolean;
}

/**
 * Syncs a single comment by Google comment ID — targeted DB lookup + single
 * Drive API call instead of batch-fetching all comments. Used by both the
 * extension's single-comment sync path and the thread refresh button.
 *
 * Uses fetchThreadDetail (comments.get with full fields) so the caller gets
 * both a DriveComment (for DB sync via buildNewComment/updateExistingComment)
 * and thread display data in one API call.
 */
export async function syncSingleComment(
  doc: Doc,
  googleCommentId: string,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
  options?: { expectFresh?: boolean; userEmail?: string },
): Promise<SingleCommentResult> {
  // Fetch the comment from Drive (returns null if content is empty/deleted).
  // When expectFresh is set (extension-triggered sync), the user just acted on
  // this comment so its modifiedTime should be recent. If Drive API returns
  // stale data (backend replication lag), retry with exponential backoff.
  const FRESH_CUTOFF = 5000;       // modifiedTime must be within 5s of request start
  const INITIAL_RETRY_DELAY = 100; // first retry after 100ms, then 1.5x each time
  const MAX_RETRY_TIME = 2000;     // give up after ~2s total retry time

  let result: ThreadDetailResult | null;
  let driveDeleted = false;
  try {
    const freshAfter = Date.now() - FRESH_CUTOFF;
    result = await fetchThreadDetail(driveAuth, doc.googleDocId, googleCommentId, options?.userEmail);
    if (options?.expectFresh) {
      let delay = INITIAL_RETRY_DELAY;
      let elapsed = 0;
      while (result && elapsed < MAX_RETRY_TIME) {
        if ((result.comment.driveModifiedAt?.getTime() ?? 0) >= freshAfter) break;
        logInfo(`[Comments] ${doc.googleDocId}: stale modifiedTime for ${googleCommentId}, retrying in ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
        elapsed += delay;
        delay *= 1.5;
        result = await fetchThreadDetail(driveAuth, doc.googleDocId, googleCommentId, options?.userEmail);
      }
    }
  } catch (err: any) {
    if (err.code === 404) {
      result = null;
      driveDeleted = true;
    } else {
      throw err;
    }
  }

  // Look up existing DB record
  const existing = await prisma.comment.findFirst({
    where: { docId: doc.docId, googleCommentId, type: "COMMENT" },
  });

  // --- Comment deleted from Drive ---
  if (!result) {
    if (existing) {
      await prisma.$transaction(async (tx) => {
        await tx.comment.delete({ where: { commentId: existing.commentId } });
        await bumpLastCommentActivity(doc.docId, [new Date()], tx);
      });
      return { comment: null, deleted: true, created: false, updated: false, shouldUnarchive: false };
    }
    return { comment: null, deleted: driveDeleted, created: false, updated: false, shouldUnarchive: false };
  }

  const c = result.comment;

  // --- New comment (not yet in DB) ---
  if (!existing) {
    const { record, unarchive } = buildNewComment(doc, c);
    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({ data: record as Prisma.CommentUncheckedCreateInput });
      await bumpLastCommentActivity(doc.docId, [c.driveCreatedAt, c.driveModifiedAt], tx);
      return created;
    });
    return { comment, thread: result.thread, created: true, updated: false, deleted: false, shouldUnarchive: unarchive };
  }

  // --- Update existing comment ---
  const updateResult = await updateExistingComment(doc, c, existing);
  return {
    comment: updateResult.comment,
    thread: result.thread,
    created: false,
    updated: updateResult.updated,
    deleted: false,
    shouldUnarchive: updateResult.unarchive,
  };
}

// --- Full sync entry point ---

export async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>,
  userEmail?: string,
  prefetched?: SyncPrefetchedData,
  hints?: SyncHints,
): Promise<SyncResult> {
  // Record sync start time BEFORE fetching — any changes that arrive during
  // the sync will have timestamps after this, ensuring the next sync covers them.
  const syncStartedAt = new Date();

  const skipComments = hints?.commentType === "suggestion";
  const skipSuggestions = hints?.commentType === "comment";

  // --- Fast path: single-comment sync via syncSingleComment ---
  // Uses a targeted DB lookup + single Drive API call instead of batch-fetching.
  if (!skipComments && hints?.googleCommentId) {
    try {
      const result = await syncSingleComment(doc, hints.googleCommentId, driveAuth, { expectFresh: true, userEmail });
      logInfo(`[Comments] ${doc.googleDocId}: single-comment sync ${hints.googleCommentId} (${result.created ? "created" : result.updated ? "updated" : result.deleted ? "deleted" : "unchanged"})`);
      return {
        ...EMPTY_RESULT,
        commentsCreated: result.created ? 1 : 0,
        commentsUpdated: result.updated ? 1 : 0,
        shouldUnarchive: result.shouldUnarchive,
        // shouldUnarchive is only true for non-resolve activity (new replies,
        // status transitions) — resolve-only changes don't trigger unarchive.
        // So aliasing it here is safe.
        hasNonResolveActivity: result.shouldUnarchive,
        thread: result.thread,
      };
    } catch (err: any) {
      // Fall back to full sync on unexpected error (e.g., 403)
      logWarning(`[Comments] single-comment sync failed for ${hints.googleCommentId}, falling back to full sync:`, err);
    }
  }

  // --- Phase 1: Fetch from APIs (or use pre-fetched data) ---

  let comments: DriveComment[];
  if (skipComments) {
    comments = [];
  } else if (prefetched?.comments) {
    comments = prefetched.comments;
  } else {
    const commentsOrError = await fetchDriveComments(doc, driveAuth, syncStartedAt, userEmail);
    if (!Array.isArray(commentsOrError)) return commentsOrError; // error result
    comments = commentsOrError;
  }

  let docsSuggestions: DriveSuggestion[];
  let suggestionFetchFailed = false;
  let suggestionPermissionDenied = false;
  if (skipSuggestions) {
    docsSuggestions = [];
  } else if (prefetched?.suggestions) {
    docsSuggestions = prefetched.suggestions;
  } else {
    const result = await fetchDocsSuggestions(doc, driveAuth);
    docsSuggestions = result.suggestions;
    suggestionFetchFailed = result.failed;
    suggestionPermissionDenied = result.denied;
  }

  // --- Phase 2: Sync comments from Drive ---

  let commentResult: CommentSyncResult;
  if (skipComments) {
    commentResult = { commentsCreated: 0, commentsUpdated: 0, commentsDeleted: 0, shouldUnarchive: false, hasNonResolveActivity: false };
  } else {
    commentResult = await syncDriveComments(doc, comments);
  }

  // --- Phase 3: Sync suggestions from Docs API ---
  // (only for Google Docs, and only if the suggestion fetch succeeded)

  if (skipSuggestions || doc.mimeType !== DOCS_MIME_TYPE) {
    // Hint-based syncs don't stamp commentsLastSyncedAt — let the periodic
    // full sync handle reconciliation of the skipped phase.
    if (!hints) await stampSyncTime(doc.docId, syncStartedAt);
    logCommentSummary(doc, comments.length, commentResult, hints);
    return { ...EMPTY_RESULT, ...commentResult };
  }

  if (suggestionFetchFailed) {
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated) (suggestions skipped: fetch failed)`);
    return { ...EMPTY_RESULT, ...commentResult, transientError: true };
  }

  if (suggestionPermissionDenied) {
    if (!hints) await stampSyncTime(doc.docId, syncStartedAt);
    logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated) (suggestions skipped: permission denied)`);
    return { ...EMPTY_RESULT, ...commentResult, permissionDenied: true };
  }

  const suggestionResult = await syncDocsSuggestions(doc, docsSuggestions);

  // Only stamp commentsLastSyncedAt for full syncs (no hints) — hint-based
  // syncs are partial and the periodic full sync should still reconcile.
  if (!hints) await stampSyncTime(doc.docId, syncStartedAt);

  logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated, ${commentResult.commentsDeleted} deleted); ${docsSuggestions.length} suggestions (${suggestionResult.suggestionsCreated} new, ${suggestionResult.suggestionsUpdated} updated, ${suggestionResult.suggestionsResolved} resolved)${commentResult.shouldUnarchive || suggestionResult.shouldUnarchive ? " → unarchive" : ""}${hints ? ` (hint: ${hints.commentType})` : ""}`);

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
    const result = await fetchCommentData(driveAuth, doc.googleDocId, { sync: true, userEmail });
    return result.comments!;
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
    const result = await fetchDocData(driveAuth, doc.googleDocId);
    return { suggestions: result.suggestions, failed: false, denied: false };
  } catch (err) {
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
    const newTs = toCreate.flatMap(c => [
      c.driveCreatedAt instanceof Date ? c.driveCreatedAt : null,
      c.driveModifiedAt instanceof Date ? c.driveModifiedAt : null,
    ]);
    await prisma.$transaction(async (tx) => {
      await tx.comment.createMany({ data: toCreate });
      await bumpLastCommentActivity(doc.docId, newTs, tx);
    });
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
 * Status rules (first match wins, see docs/inbox-states.md):
 *   @-mention or assigned-to-me → INBOX (even if resolved)
 *   I'm the doc author → INBOX (if not resolved)
 *   I participated (authored or replied) → INBOX (if not resolved)
 *   Otherwise: ARCHIVED
 */
function buildNewComment(
  doc: Doc,
  c: DriveComment,
): { record: Prisma.CommentCreateManyInput; unarchive: boolean; nonResolveActivity: boolean } {
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
  const mentionedOrAssigned = mentionedInThread || c.assignedToMe;
  const status: "INBOX" | "ARCHIVED" = mentionedOrAssigned
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
  // Track non-resolve activity: unresolved comments or @-mentions/assignments (even on resolved)
  const nonResolveActivity = (!c.resolved || mentionedOrAssigned) && !c.isRead;

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
): Promise<{ comment: Comment; updated: boolean; unarchive: boolean; nonResolveActivity: boolean }> {
  const hasNewReplies = c.replyCount > existing.replyCount;
  const hasNewActivity =
    hasNewReplies ||
    (!existing.resolved && c.resolved) ||
    (existing.resolved && !c.resolved) ||
    !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);

  // @-mention or assignment in new replies breaks out of MUTED
  // (see docs/inbox-states.md rule 2).
  const newReplyMentionsMe = hasNewReplies &&
    (c.replyMentionedMeFlags ?? []).slice(existing.replyCount).some(Boolean);
  const newReplyAssignsMe = hasNewReplies &&
    (c.replyAssignedToMeFlags ?? []).slice(existing.replyCount).some(Boolean);

  // MUTED fast-path: update metadata but preserve MUTED status unless @-mentioned or assigned
  if (existing.status === "MUTED" && !newReplyMentionsMe && !newReplyAssignsMe) {
    const { changed, data } = buildCommentUpdate(existing, c);
    let comment = existing;
    if (changed) {
      comment = await prisma.$transaction(async (tx) => {
        const updated = await tx.comment.update({ where: { commentId: existing.commentId }, data });
        await bumpLastCommentActivity(doc.docId, [c.driveCreatedAt, c.driveModifiedAt], tx);
        return updated;
      });
    }
    return { comment, updated: changed, unarchive: false, nonResolveActivity: false };
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
  const status = computeCommentStatus(doc, c, existing, previousStatus, hasNewActivity, hasNewReplies, newReplyMentionsMe, newReplyAssignsMe);

  if (newReplyMentionsMe || newReplyAssignsMe) {
    // @-mention or assignment always counts as activity even if isRead
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

  const { changed, data } = buildCommentUpdate(existing, c, status);
  let comment = existing;
  if (changed) {
    comment = await prisma.$transaction(async (tx) => {
      const updated = await tx.comment.update({ where: { commentId: existing.commentId }, data });
      await bumpLastCommentActivity(doc.docId, [c.driveCreatedAt, c.driveModifiedAt], tx);
      return updated;
    });
  }

  return { comment, updated: changed, unarchive, nonResolveActivity };
}

/**
 * Determines a comment's target status based on spec rules (first match wins,
 * see docs/inbox-states.md for the authoritative rule list):
 *   @-mention or assignment in new reply → INBOX (overrides MUTED)
 *   I resolved it → ARCHIVED
 *   New activity + (mentioned/assigned/doc author/participant) → INBOX
 */
function computeCommentStatus(
  doc: Doc,
  c: DriveComment,
  existing: Comment,
  previousStatus: "INBOX" | "ARCHIVED" | "MUTED",
  hasNewActivity: boolean,
  hasNewReplies: boolean,
  newReplyMentionsMe: boolean,
  newReplyAssignsMe: boolean,
): "INBOX" | "ARCHIVED" | "MUTED" {
  if (newReplyMentionsMe || newReplyAssignsMe) return "INBOX";
  if (c.resolved && c.iResolvedIt) return "ARCHIVED";

  if (hasNewActivity) {
    // I was mentioned or assigned anywhere in the thread — new activity brings
    // it back to INBOX (even if I previously archived it). MUTED comments never
    // reach here (handled by the fast-path in updateExistingComment).
    const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
    if (mentionedInThread || c.assignedToMe) return "INBOX";
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

/** Builds the common Prisma update data and detects whether anything changed. */
function buildCommentUpdate(
  existing: Comment,
  c: DriveComment,
  newStatus?: CommentStatus,
): { changed: boolean; data: Prisma.CommentUncheckedUpdateInput } {
  const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
  const effectiveIsRead = modifiedChanged ? c.isRead : existing.isRead;
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
  const status = newStatus ?? existing.status;

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

  const data: Prisma.CommentUncheckedUpdateInput = {
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
  };

  return { changed, data };
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
        status: doc.role === "AUTHOR" ? "INBOX" : "ARCHIVED",
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
      // Metadata correction only (adopting Gmail-first ID, fixing type/hash) —
      // not new activity, so no bumpLastCommentActivity here.
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

  // Identify suggestions to resolve (no longer in the document).
  // Rows with a googleSuggestionId are resolved if their ID isn't in the live set.
  // Rows without a googleSuggestionId (extension-only or Gmail-first) are checked
  // by content hash against live suggestions — if a live suggestion has the same
  // hash, the row likely represents it and should not be resolved.
  const activeSuggestions = await prisma.comment.findMany({
    where: { docId: doc.docId, type: "SUGGESTION", resolved: false },
  });
  const liveHashes = new Set(docsSuggestions.map(s =>
    computeSuggestionHash(s.suggestionType, s.deletedText, s.insertedText)
  ));
  const toResolve = activeSuggestions.filter(s => {
    if (s.googleSuggestionId) return !liveIds.has(s.googleSuggestionId);
    // Extension-only / Gmail-first row: check content hash against live suggestions
    return !s.suggestionContentHash || !liveHashes.has(s.suggestionContentHash);
  });

  if (toCreate.length > 0) {
    const newTs = toCreate.map(c => c.driveCreatedAt instanceof Date ? c.driveCreatedAt : null);
    await prisma.$transaction(async (tx) => {
      await tx.comment.createMany({ data: toCreate });
      await bumpLastCommentActivity(doc.docId, newTs, tx);
    });
  }

  if (toResolve.length > 0) {
    // Batch-resolve all absent suggestions + bump in one transaction.
    // INBOX suggestions move to ARCHIVED; MUTED stays MUTED.
    const resolveInbox = toResolve.filter(s => s.status === "INBOX").map(s => s.commentId);
    const resolveOther = toResolve.filter(s => s.status !== "INBOX").map(s => s.commentId);
    await prisma.$transaction(async (tx) => {
      if (resolveInbox.length > 0) {
        await tx.comment.updateMany({
          where: { commentId: { in: resolveInbox } },
          data: { resolved: true, status: "ARCHIVED" },
        });
      }
      if (resolveOther.length > 0) {
        await tx.comment.updateMany({
          where: { commentId: { in: resolveOther } },
          data: { resolved: true },
        });
      }
      await bumpLastCommentActivity(doc.docId, [new Date()], tx);
    });
  }
  const resolved = toResolve.length;

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

function logCommentSummary(doc: Doc, commentCount: number, result: CommentSyncResult, hints?: SyncHints) {
  logInfo(`[Comments] ${doc.googleDocId}: ${commentCount} from Drive (${result.commentsCreated} new, ${result.commentsUpdated} updated, ${result.commentsDeleted} deleted)${result.shouldUnarchive ? " → unarchive" : ""}${hints ? ` (hint: ${hints.commentType}${hints.googleCommentId ? ' single' : ''})` : ""}`);
}

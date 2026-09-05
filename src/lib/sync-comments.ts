import { prisma } from "@/lib/prisma";
import { fetchCommentData, fetchDocData, fetchThreadDetail, getDriveClient, isDriveErrorCode } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { ExtCommentType } from "@/lib/extension-wire";
import { GoogleMimeType } from "@/lib/mime-types";
import { computeSuggestionHash } from "@/lib/suggestion-hash";
import { initialReadSlotCount, nextReadSlotCount, renderReadCount } from "@/lib/read-state";
import { CommentStatus, CommentType, DocRole, DocStatus, type Doc, type Comment, type Prisma } from "@prisma/client";
import type { DriveComment, DriveSuggestion, SuggestionsUnavailable, CommentThread, ThreadDetailResult } from "@/lib/google-drive";

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

/**
 * Find existing suggestion rows in a doc that match a given content hash and
 * have not yet been paired with a disco ID (`googleCommentId: null`). Used by
 * Gmail and extension merge paths to decide whether to enrich an existing
 * Drive-sourced row or insert a new one.
 */
export async function findUnlinkedSuggestionsByHash(
  docId: string,
  contentHash: string,
): Promise<Comment[]> {
  return prisma.comment.findMany({
    where: {
      docId,
      type: CommentType.SUGGESTION,
      suggestionContentHash: contentHash,
      googleCommentId: null,
    },
  });
}

// --- Result type ---

interface SyncResult {
  commentsCreated: number;
  commentsUpdated: number;
  suggestionsCreated: number;
  suggestionsUpdated: number;
  suggestionsResolved: number;
  shouldUnarchive: boolean;
  isDeleted?: boolean;
  /** Drive refused this doc's *comments* — nothing synced. Callers count it as
   *  a failed doc (see `allFailed` in `docs/refresh.md`). */
  permissionDenied?: boolean;
  /** Drive refused only this doc's *suggestions* (the view-only case). The
   *  comment sync still succeeded, so this is not a failed doc — it's kept
   *  separate from `permissionDenied` so one view-only doc can't drag the
   *  success count to zero and block the Drive changes-token update. */
  suggestionsDenied?: boolean;
  transientError?: boolean;
  /** Thread display data from single-comment sync, so callers can pass it
   *  to the client without a redundant Drive API fetch. */
  thread?: CommentThread;
}

const EMPTY_RESULT: SyncResult = {
  commentsCreated: 0, commentsUpdated: 0,
  suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
  shouldUnarchive: false,
};

// --- Helpers ---

export function datesEqual(a: Date | null | undefined, b: Date | null | undefined): boolean {
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
  /** Why the pre-fetched `suggestions` list is empty, when it isn't because the
   *  doc has none. Must be passed along with `suggestions` — without it an
   *  unreadable doc looks like one whose suggestions were all closed. */
  suggestionsUnavailable?: SuggestionsUnavailable;
}

/**
 * Optional hints from the Chrome extension telling us which specific action
 * the user just took. Allows skipping irrelevant API calls and fetching only
 * the affected comment instead of all comments.
 */
export interface SyncHints {
  /** Which kind of thread the user acted on, in the extension's own spelling. */
  commentType?: ExtCommentType;
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
  /** Drive returned 403 — comment access was revoked, so nothing was synced.
   *  Distinct from a 404, which means the comment itself is gone. */
  permissionDenied?: boolean;
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
  options?: { expectRecentComment?: boolean; userEmail?: string; selfEdited?: boolean },
): Promise<SingleCommentResult> {
  // Fetch the comment from Drive (returns null if content is empty/deleted).
  // When expectRecentComment is set, the caller just observed (or performed)
  // an action on this comment, so its modifiedTime should be recent. If Drive
  // API returns stale data (backend replication lag), retry with exponential backoff.
  const FRESH_CUTOFF = 5000;       // modifiedTime must be within 5s of request start
  const INITIAL_RETRY_DELAY = 100; // first retry after 100ms, then 1.5x each time
  const MAX_RETRY_TIME = 2000;     // give up after ~2s total retry time

  let result: ThreadDetailResult | null;
  let driveDeleted = false;
  let drivePermissionDenied = false;
  try {
    const freshAfter = Date.now() - FRESH_CUTOFF;
    result = await fetchThreadDetail(driveAuth, doc.googleDocId, googleCommentId, options?.userEmail);
    if (options?.expectRecentComment) {
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
  } catch (err) {
    if (isDriveErrorCode(err, 404)) {
      result = null;
      driveDeleted = true;
    } else if (isDriveErrorCode(err, 403)) {
      // Comment access was revoked. Unlike a 404 this says nothing about
      // whether the comment still exists, so leave the DB record alone. (A full
      // sync may still delete it later if comments.list succeeds without it —
      // but that path has seen the whole list, and this one hasn't.)
      logWarning(`[Comments] permission denied for ${doc.googleDocId} comment ${googleCommentId} (code 403)`);
      result = null;
      drivePermissionDenied = true;
    } else {
      throw err;
    }
  }

  // Look up existing DB record
  const existing = await prisma.comment.findFirst({
    where: { docId: doc.docId, googleCommentId, type: CommentType.COMMENT },
  });

  if (drivePermissionDenied) {
    return {
      comment: existing,
      created: false,
      updated: false,
      deleted: false,
      shouldUnarchive: false,
      permissionDenied: true,
    };
  }

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
  const updateResult = await updateExistingComment(doc, c, existing, options?.selfEdited);
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

  const skipComments = hints?.commentType === ExtCommentType.Suggestion;
  const skipSuggestions = hints?.commentType === ExtCommentType.Comment;

  // --- Fast path: single-comment sync via syncSingleComment ---
  // Uses a targeted DB lookup + single Drive API call instead of batch-fetching.
  if (!skipComments && hints?.googleCommentId) {
    try {
      const result = await syncSingleComment(doc, hints.googleCommentId, driveAuth, { expectRecentComment: true, userEmail });
      // A 403 on the targeted fetch says nothing about the rest of the doc, so
      // fall through to the full sync — it stamps sync time and flags the denial.
      if (!result.permissionDenied) {
        logInfo(`[Comments] ${doc.googleDocId}: single-comment sync ${hints.googleCommentId} (${result.created ? "created" : result.updated ? "updated" : result.deleted ? "deleted" : "unchanged"})`);
        return {
          ...EMPTY_RESULT,
          commentsCreated: result.created ? 1 : 0,
          commentsUpdated: result.updated ? 1 : 0,
          shouldUnarchive: result.shouldUnarchive,
          thread: result.thread,
        };
      }
    } catch (err) {
      // Fall back to full sync on unexpected error (403 is handled above)
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
  } else if (prefetched?.suggestions || prefetched?.suggestionsUnavailable) {
    docsSuggestions = prefetched.suggestions ?? [];
    suggestionFetchFailed = prefetched.suggestionsUnavailable === "error";
    suggestionPermissionDenied = prefetched.suggestionsUnavailable === "denied";
  } else {
    const result = await fetchDocsSuggestions(doc, driveAuth);
    docsSuggestions = result.suggestions;
    suggestionFetchFailed = result.failed;
    suggestionPermissionDenied = result.denied;
  }

  // --- Phase 2: Sync comments from Drive ---

  let commentResult: CommentSyncResult;
  if (skipComments) {
    commentResult = { commentsCreated: 0, commentsUpdated: 0, commentsDeleted: 0, shouldUnarchive: false };
  } else {
    commentResult = await syncDriveComments(doc, comments);
  }

  // --- Phase 3: Sync suggestions from Docs API ---
  // (only for Google Docs, and only if the suggestion fetch succeeded)

  if (skipSuggestions || doc.mimeType !== GoogleMimeType.Doc) {
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
    return { ...EMPTY_RESULT, ...commentResult, suggestionsDenied: true };
  }

  // Reaching here means the Docs API read succeeded: both the failed and the
  // denied cases returned above. So an empty `docsSuggestions` is authoritative
  // — but only on a full sync. Hint-driven syncs run moments after the user
  // acted in the doc, where a lagging Docs read can report an empty document
  // that isn't (the same read-after-write lag `syncSingleComment` retries
  // around). They're partial by design and don't even stamp the sync time, so
  // leave the ID-less rows for the next full sync to close.
  const suggestionResult = await syncDocsSuggestions(doc, docsSuggestions, { closeIdlessRows: !hints });

  // Only stamp commentsLastSyncedAt for full syncs (no hints) — hint-based
  // syncs are partial and the periodic full sync should still reconcile.
  if (!hints) await stampSyncTime(doc.docId, syncStartedAt);

  logInfo(`[Comments] ${doc.googleDocId}: ${comments.length} comments from Drive (${commentResult.commentsCreated} new, ${commentResult.commentsUpdated} updated, ${commentResult.commentsDeleted} deleted); ${docsSuggestions.length} suggestions (${suggestionResult.suggestionsCreated} new, ${suggestionResult.suggestionsUpdated} updated, ${suggestionResult.suggestionsResolved} resolved)${commentResult.shouldUnarchive || suggestionResult.shouldUnarchive ? " → unarchive" : ""}${hints ? ` (hint: ${hints.commentType})` : ""}`);

  return {
    commentsCreated: commentResult.commentsCreated,
    commentsUpdated: commentResult.commentsUpdated,
    ...suggestionResult,
    shouldUnarchive: commentResult.shouldUnarchive || suggestionResult.shouldUnarchive,
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
  } catch (err) {
    if (isDriveErrorCode(err, 404)) {
      logWarning(`[Comments] doc ${doc.googleDocId} not found (code 404)`);
      return { ...EMPTY_RESULT, isDeleted: true };
    }
    if (isDriveErrorCode(err, 403)) {
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
  if (doc.mimeType !== GoogleMimeType.Doc) {
    return { suggestions: [], failed: false, denied: false };
  }
  try {
    const result = await fetchDocData(driveAuth, doc.googleDocId);
    // fetchDocData swallows its own errors, so an empty list needs the
    // accompanying flag to be read correctly (see SuggestionsUnavailable).
    return {
      suggestions: result.suggestions,
      failed: result.suggestionsUnavailable === "error",
      denied: result.suggestionsUnavailable === "denied",
    };
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

  // Batch-fetch all existing comments for this doc to avoid N+1 queries
  const existingComments = new Map(
    (await prisma.comment.findMany({
      where: { docId: doc.docId, type: CommentType.COMMENT },
    })).map((c) => [c.googleCommentId, c])
  );

  for (const c of comments) {
    const existing = existingComments.get(c.id) ?? null;

    if (!existing) {
      const { record, unarchive } = buildNewComment(doc, c);
      toCreate.push(record);
      if (unarchive) shouldUnarchive = true;
    } else {
      const result = await updateExistingComment(doc, c, existing);
      if (result.updated) updatedCount++;
      if (result.unarchive) shouldUnarchive = true;
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
  };
}

/**
 * Shared initial status computation for new comments and suggestions.
 * Rules (first match wins, see docs/inbox-states.md):
 *   @-mention or assigned-to-me → INBOX (even if resolved)
 *   resolved → ARCHIVED
 *   doc author or participant → INBOX
 *   otherwise → ARCHIVED
 */
export function computeInitialInboxStatus(opts: {
  mentionedOrAssigned: boolean;
  resolved: boolean;
  isDocAuthor: boolean;
  isThreadAuthor: boolean;
  isReplyAuthor: boolean;
}): typeof CommentStatus.INBOX | typeof CommentStatus.ARCHIVED {
  if (opts.mentionedOrAssigned) return CommentStatus.INBOX;
  if (opts.resolved) return CommentStatus.ARCHIVED;
  if (opts.isDocAuthor || opts.isThreadAuthor || opts.isReplyAuthor) return CommentStatus.INBOX;
  return CommentStatus.ARCHIVED;
}

/**
 * Builds a new comment record and determines its initial status.
 */
function buildNewComment(
  doc: Doc,
  c: DriveComment,
): { record: Prisma.CommentCreateManyInput; unarchive: boolean } {
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
  const mentionedOrAssigned = mentionedInThread || c.assignedToMe;
  const status = computeInitialInboxStatus({
    mentionedOrAssigned,
    resolved: c.resolved,
    isDocAuthor: doc.role === DocRole.AUTHOR,
    isThreadAuthor: c.isThreadAuthor,
    isReplyAuthor: c.isReplyAuthor,
  });

  const readSlotCount = initialReadSlotCount(c.isThreadAuthor, c.replyAuthorMeFlags);
  const record: Prisma.CommentCreateManyInput = {
    docId: doc.docId,
    googleCommentId: c.id,
    type: CommentType.COMMENT,
    resolved: c.resolved,
    isThreadAuthor: c.isThreadAuthor,
    isReplyAuthor: c.isReplyAuthor,
    readSlotCount,
    readMessageCount: renderReadCount(c.replyDeleted, readSlotCount),
    assignedToMe: c.assignedToMe,
    mentionedMe: mentionedInThread,
    mentionedMeUnreplied: c.mentionedMeUnreplied,
    status,
    driveCreatedAt: c.driveCreatedAt,
    driveModifiedAt: c.driveModifiedAt,
    replyCount: c.replyCount,
    replySlotCount: c.replySlotCount,
  };

  // Doc-level unarchive: new INBOX comment triggers unarchive, but not if
  // already read (my own activity shouldn't resurface an archived doc).
  const unarchive = status === CommentStatus.INBOX && !c.isRead;

  return { record, unarchive };
}

/**
 * Updates an existing comment with new data from Drive.
 * Handles MUTED fast-path, status transitions, and unarchive signals.
 */
async function updateExistingComment(
  doc: Doc,
  c: DriveComment,
  existing: Comment,
  /** This sync follows an edit or delete the user just made from Docreview.
   *  Their own edit bumps Drive's modifiedTime, but it isn't activity that
   *  should pull the comment back into their Inbox or mark it unread — so the
   *  modifiedTime test alone is skipped. Everything else still counts, so
   *  replies that arrive from other people in the same window are handled
   *  exactly as they would be on any other sync. */
  selfEdited?: boolean,
): Promise<{ comment: Comment; updated: boolean; unarchive: boolean }> {
  // Slot space, not the live count: a delete and a reply landing in the same
  // sync window leave the live count unchanged, which would hide the reply
  // completely. Slot counts only ever grow, so this can't false-negative.
  const hasNewReplies = c.replySlotCount > existing.replySlotCount;
  // ...but only the *live* new slots are content the user can be shown. A reply
  // posted and deleted between two syncs arrives as a brand-new tombstone slot,
  // and moving the doc to Inbox for it strands the user on a doc with nothing
  // in it that explains why it came back.
  const newSlots = c.replyDeleted.slice(existing.replySlotCount);
  const hasNewLiveReplies = newSlots.some((deleted) => !deleted);
  // Whether something was deleted this sync: a slot arrived already dead, or the
  // live count dropped while the slot count held. The slot-count condition is
  // what keeps this from firing on a stored count that was too high to begin
  // with rather than on a real deletion — a Gmail-created row seeds
  // `replySlotCount` from the notification's reply list (see comment-merge.ts),
  // which can overshoot what Drive later reports. A real deletion never lowers
  // the slot count.
  const deletedThisSync =
    newSlots.some((deleted) => deleted) ||
    (c.replySlotCount >= existing.replySlotCount && c.replyCount < existing.replyCount);
  const resolveFlipped = existing.resolved !== c.resolved;
  // A deletion with nothing live to replace it isn't activity worth surfacing:
  // there is nothing new to read, so it must not mark the thread unread, move it
  // to Inbox, or unarchive the doc — a doc that comes back to Inbox needs an
  // unread comment on it to justify the trip. A resolve flip is exempt: it's a
  // state change we'd never see again if this sync dropped it (the new `resolved`
  // is committed below either way), and it resurfaces the thread's last live
  // message as unread, so the doc still has something to show. An edit alongside
  // a deletion *is* swallowed, which is the accepted cost of Drive reporting one
  // thread-level modifiedTime and no per-message detail.
  const deletionOnly = deletedThisSync && !hasNewLiveReplies && !resolveFlipped;
  const hasNewActivity =
    !deletionOnly &&
    (hasNewLiveReplies ||
      resolveFlipped ||
      (!selfEdited && !datesEqual(existing.driveModifiedAt, c.driveModifiedAt)));

  // @-mention or assignment in new replies breaks out of MUTED
  // (see docs/inbox-states.md rule 2).
  const newReplyMentionsMe = hasNewReplies &&
    (c.replyMentionedMeFlags ?? []).slice(existing.replySlotCount).some(Boolean);
  const newReplyAssignsMe = hasNewReplies &&
    (c.replyAssignedToMeFlags ?? []).slice(existing.replySlotCount).some(Boolean);

  // MUTED fast-path: update metadata but preserve MUTED status unless @-mentioned or assigned
  if (existing.status === CommentStatus.MUTED && !newReplyMentionsMe && !newReplyAssignsMe) {
    const { changed, data } = buildCommentUpdate(existing, c, undefined, hasNewActivity);
    let comment = existing;
    if (changed) {
      comment = await prisma.$transaction(async (tx) => {
        const updated = await tx.comment.update({ where: { commentId: existing.commentId }, data });
        await bumpLastCommentActivity(doc.docId, [c.driveCreatedAt, c.driveModifiedAt], tx);
        return updated;
      });
    }
    return { comment, updated: changed, unarchive: false };
  }

  const previousStatus = existing.status;

  // Determine the target status using spec rules (first matching rule wins)
  const status = computeCommentStatus(doc, c, existing, previousStatus, hasNewActivity, hasNewReplies, newReplyMentionsMe, newReplyAssignsMe);

  // Doc-level unarchive rules. All gated on !c.isRead.
  let unarchive = false;
  if (!c.isRead) {
    // 1. Comment transitions from non-INBOX to INBOX
    if (previousStatus !== CommentStatus.INBOX && status === CommentStatus.INBOX) unarchive = true;
    // 2. Existing INBOX comment gets new replies (unless I resolved it myself)
    if (previousStatus === CommentStatus.INBOX && hasNewLiveReplies && !(c.resolved && c.iResolvedIt)) unarchive = true;
    // 3. INBOX comment resolved by someone else. The *transition* is the
    // activity worth surfacing, so this tests the resolve arriving, not the
    // standing fact that the thread is resolved. Without `!existing.resolved`
    // the condition never stops being true and every later sync re-unarchives
    // the doc, which makes archiving it impossible.
    if (previousStatus === CommentStatus.INBOX && !existing.resolved && c.resolved && !c.iResolvedIt) unarchive = true;
  }

  const { changed, data } = buildCommentUpdate(existing, c, status, hasNewActivity);
  let comment = existing;
  if (changed) {
    comment = await prisma.$transaction(async (tx) => {
      const updated = await tx.comment.update({ where: { commentId: existing.commentId }, data });
      await bumpLastCommentActivity(doc.docId, [c.driveCreatedAt, c.driveModifiedAt], tx);
      return updated;
    });
  }

  return { comment, updated: changed, unarchive };
}

/**
 * Determines a comment's target status based on spec rules (first match wins,
 * see docs/inbox-states.md for the authoritative rule list):
 *   @-mention or assignment in new reply → INBOX (overrides MUTED)
 *   I resolved it → ARCHIVED
 *   New activity + (mentioned/assigned/doc author/participant) → INBOX
 *
 * Keep in sync with computeSuggestionStatusUpdate() in extension-suggestion-merge.ts.
 */
function computeCommentStatus(
  doc: Doc,
  c: DriveComment,
  existing: Comment,
  previousStatus: CommentStatus,
  hasNewActivity: boolean,
  hasNewReplies: boolean,
  newReplyMentionsMe: boolean,
  newReplyAssignsMe: boolean,
): CommentStatus {
  if (newReplyMentionsMe || newReplyAssignsMe) return CommentStatus.INBOX;
  if (c.resolved && c.iResolvedIt) return CommentStatus.ARCHIVED;

  if (hasNewActivity) {
    // I was mentioned or assigned anywhere in the thread — new activity brings
    // it back to INBOX (even if I previously archived it). MUTED comments never
    // reach here (handled by the fast-path in updateExistingComment).
    const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
    if (mentionedInThread || c.assignedToMe) return CommentStatus.INBOX;
    if (doc.role === DocRole.AUTHOR) return CommentStatus.INBOX;
    if (c.isThreadAuthor && hasNewReplies) {
      // Only INBOX if someone else replied (not just my own self-replies)
      // Tombstones are excluded: a slot that arrived already deleted carries no
      // author, so "not me" would be a false positive for "someone else replied".
      const newReplies = c.replyAuthorMeFlags
        .map((me, i) => ({ me, deleted: c.replyDeleted[i] === true }))
        .slice(existing.replySlotCount);
      if (newReplies.some((r) => !r.deleted && !r.me)) return CommentStatus.INBOX;
    } else if (c.isReplyAuthor && !c.isThreadAuthor) {
      // I participated on someone else's thread — any activity → INBOX
      return CommentStatus.INBOX;
    }
  }

  return previousStatus;
}

/** Builds the common Prisma update data and detects whether anything changed. */
function buildCommentUpdate(
  existing: Comment,
  c: DriveComment,
  newStatus?: CommentStatus,
  /** Whether the sync found activity worth reacting to. Defaults to "yes if the
   *  timestamp moved", which is what every caller but the self-edit path means;
   *  a self-edit moves the timestamp without being activity, and must not clear
   *  the read flag. */
  hasNewActivity?: boolean,
): { changed: boolean; data: Prisma.CommentUncheckedUpdateInput } {
  const modifiedChanged = !datesEqual(existing.driveModifiedAt, c.driveModifiedAt);
  const activity = hasNewActivity ?? modifiedChanged;
  // Read tracking: the rules live in nextReadSlotCount, shared with the
  // extension suggestion merge. `c.isRead` is Drive's "I authored the last
  // message". A timestamp move that isn't real activity (a self-edit) doesn't
  // count, which is what keeps the user's own edit from marking their thread
  // unread.
  const effectiveReadSlotCount = nextReadSlotCount({
    storedCount: existing.readSlotCount,
    oldReplySlotCount: existing.replySlotCount,
    replyDeleted: c.replyDeleted,
    hasActivity: modifiedChanged && activity,
    iActedLast: c.isRead,
  });
  // The same boundary in render space, cached so the docs table can count
  // unread without the slot array. Only a boundary move or a deletion below it
  // changes this — arriving replies leave it alone, which is what makes exactly
  // those replies unread.
  const effectiveReadMessageCount = renderReadCount(c.replyDeleted, effectiveReadSlotCount);
  const mentionedInThread = c.mentionedMe || (c.replyMentionedMeFlags ?? []).some(Boolean);
  const status = newStatus ?? existing.status;

  const changed =
    existing.resolved !== c.resolved ||
    existing.isReplyAuthor !== c.isReplyAuthor ||
    existing.readSlotCount !== effectiveReadSlotCount ||
    existing.readMessageCount !== effectiveReadMessageCount ||
    existing.assignedToMe !== c.assignedToMe ||
    existing.mentionedMe !== mentionedInThread ||
    existing.mentionedMeUnreplied !== c.mentionedMeUnreplied ||
    existing.status !== status ||
    !datesEqual(existing.driveCreatedAt, c.driveCreatedAt) ||
    modifiedChanged ||
    existing.replyCount !== c.replyCount ||
    existing.replySlotCount !== c.replySlotCount;

  const data: Prisma.CommentUncheckedUpdateInput = {
    resolved: c.resolved,
    isReplyAuthor: c.isReplyAuthor,
    readSlotCount: effectiveReadSlotCount,
    readMessageCount: effectiveReadMessageCount,
    assignedToMe: c.assignedToMe,
    mentionedMe: mentionedInThread,
    mentionedMeUnreplied: c.mentionedMeUnreplied,
    status,
    driveCreatedAt: c.driveCreatedAt,
    driveModifiedAt: c.driveModifiedAt,
    replyCount: c.replyCount,
    replySlotCount: c.replySlotCount,
  };

  return { changed, data };
}

// --- Phase 3: Sync suggestions ---

interface SuggestionSyncResult {
  suggestionsCreated: number;
  suggestionsUpdated: number;
  suggestionsResolved: number;
  shouldUnarchive: boolean;
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
 *
 * `docsSuggestions` must be an authoritative read — callers resolve rows from
 * its absences, so a list left empty by a failed or forbidden fetch would close
 * every suggestion on the doc.
 */
async function syncDocsSuggestions(
  doc: Doc,
  docsSuggestions: DriveSuggestion[],
  options: { closeIdlessRows: boolean },
): Promise<SuggestionSyncResult> {
  // Build lookup maps: by googleSuggestionId (primary) and by content hash
  // (fallback for Gmail-first rows that don't have a googleSuggestionId yet).
  const allExisting = await prisma.comment.findMany({
    where: { docId: doc.docId, type: CommentType.SUGGESTION },
    select: {
      commentId: true,
      googleSuggestionId: true,
      googleCommentId: true,
      suggestionType: true,
      suggestionContentHash: true,
    },
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
    } else if (!existing.googleCommentId) {
      // Found by suggestion ID, but missing disco ID. Check if there's a
      // disco-only record with the same hash that we should merge with. The
      // partner must actually have a `googleCommentId` to contribute; a
      // hash-only row (both IDs null) shouldn't exist in today's code, but
      // defensively filter so we never delete a partner that adds nothing.
      const hashCandidates = (byContentHash.get(contentHash) ?? []).filter((c) => c.googleCommentId);
      if (hashCandidates.length === 1) {
        const partner = hashCandidates[0];
        const currentExisting = existing;
        logInfo(`[Suggestions:Docs] ${doc.googleDocId}: merging suggestion-only row ${currentExisting.commentId} into disco-only partner ${partner.commentId} by hash`);
        await prisma.$transaction(async (tx) => {
          await tx.comment.delete({ where: { commentId: currentExisting.commentId } });
          await tx.comment.update({
            where: { commentId: partner.commentId },
            data: { googleSuggestionId: s.id },
          });
        });
        // Keep the in-memory maps in sync with the DB, otherwise a later
        // suggestion with the same hash would re-match `partner` through
        // `byContentHash` (still listed as unlinked) and clobber the
        // googleSuggestionId we just assigned. Likewise `byGoogleSuggestionId`
        // must now point at the surviving partner row, not the deleted one.
        const merged = { ...partner, googleSuggestionId: s.id };
        byGoogleSuggestionId.set(s.id, merged);
        const fullList = byContentHash.get(contentHash) ?? [];
        const remaining = fullList.filter((r) => r.commentId !== partner.commentId);
        if (remaining.length > 0) byContentHash.set(contentHash, remaining);
        else byContentHash.delete(contentHash);
        updated++;
        // Skip the fall-through metadata update: by construction the merged
        // partner's hash and suggestionType already match `s`, and we just set
        // googleSuggestionId. Letting the fall-through run would double-count
        // `updated` if any invariant ever slipped.
        continue;
      }
    }

    if (!existing) {
      const sugCreatedAt = doc.lastModifiedInDrive ?? new Date();
      toCreate.push({
        docId: doc.docId,
        googleSuggestionId: s.id,
        type: CommentType.SUGGESTION,
        suggestionType: s.suggestionType,
        suggestionContentHash: contentHash,
        resolved: false,
        status: doc.role === DocRole.AUTHOR ? CommentStatus.INBOX : CommentStatus.ARCHIVED,
        driveCreatedAt: sugCreatedAt,
        driveModifiedAt: sugCreatedAt,
      });
      if (doc.role === DocRole.AUTHOR) shouldUnarchive = true;
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
  // Normally we only resolve rows that have a googleSuggestionId — those were
  // matched to a Docs API suggestion and can be reliably tracked by ID.  Rows
  // without one came from Gmail or the extension and may not be findable via
  // the Docs API (e.g. content hash mismatch), so their absence from a
  // non-empty live set proves nothing.
  //
  // The exception is an empty live set on a full sync: the read found no open
  // suggestions anywhere it looks, so there is no live suggestion any row could
  // have failed to match, and a hash mismatch can't explain the absence.  Every
  // unresolved row is therefore closed, whatever IDs it carries.  ("Anywhere it
  // looks" is the caveat: the fields mask covers tab bodies, tables and TOCs,
  // not headers/footers/footnotes — see docs/suggestions.md.)  Without this, an accept/reject that
  // happened while neither Docreview nor the extension was watching leaves
  // disco-only rows stuck open forever — a refresh alone could never clear
  // them.  We can't tell accepted from rejected from deleted here, but we don't
  // make that distinction for googleSuggestionId rows either: absence is the
  // only signal the Docs API gives us, and it means closed.
  const closeIdlessRows = options.closeIdlessRows && docsSuggestions.length === 0;
  const activeSuggestions = await prisma.comment.findMany({
    where: {
      docId: doc.docId,
      type: CommentType.SUGGESTION,
      resolved: false,
      ...(closeIdlessRows ? {} : { googleSuggestionId: { not: null } }),
    },
  });
  const toResolve = activeSuggestions.filter(
    s => !s.googleSuggestionId || !liveIds.has(s.googleSuggestionId)
  );
  const idless = toResolve.filter(s => !s.googleSuggestionId).length;
  if (idless > 0) {
    logInfo(`[Suggestions:Docs] ${doc.googleDocId}: no live suggestions — closing ${idless} row(s) with no suggestion ID`);
  }

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
    const resolveInbox = toResolve.filter(s => s.status === CommentStatus.INBOX).map(s => s.commentId);
    const resolveOther = toResolve.filter(s => s.status !== CommentStatus.INBOX).map(s => s.commentId);
    await prisma.$transaction(async (tx) => {
      if (resolveInbox.length > 0) {
        await tx.comment.updateMany({
          where: { commentId: { in: resolveInbox } },
          data: { resolved: true, status: CommentStatus.ARCHIVED },
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
  };
}

/**
 * If sync results indicate a comment/suggestion moved to INBOX, move the
 * parent doc to INBOX too (if it's currently ARCHIVED).
 * Returns true if the doc was unarchived.
 */
export async function unarchiveDocIfNeeded(
  docId: string,
  docStatus: DocStatus,
  shouldUnarchive: boolean,
): Promise<boolean> {
  if (docStatus === DocStatus.ARCHIVED && shouldUnarchive) {
    await prisma.doc.update({ where: { docId }, data: { status: DocStatus.INBOX } });
    logInfo(`[Sync] Unarchived doc ${docId} — comment/suggestion moved to INBOX`);
    return true;
  }
  return false;
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

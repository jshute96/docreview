// Merges suggestion data from the Chrome extension (DOM scraping) into the database.
//
// Similar to mergeSuggestionsFromGmail but with extension-specific data:
// - Disco IDs (AAA[A-Z]... format, same as Gmail's discussionId)
// - Suggestion type, old/new text (for content hash)
// - Accept/reject status (maps to resolved: true)
// - Author name and isMine flag
// - Reply count
// - Relative timestamps from the DOM
//
// Merge strategy:
//   1. Check if disco ID already exists in the doc → update metadata
//   2. Compute content hash, look up rows without a googleCommentId
//   3. Exactly one match → merge disco ID, author, reply count, status
//   4. No match or multiple matches → insert new row (extension-first)

import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { computeSuggestionHash, gmailActionToSuggestionType, extractHashTextsFromExtension } from "@/lib/suggestion-hash";
import { computeMentionedMeUnreplied } from "@/lib/google-drive";
import { bumpLastCommentActivity, computeInitialInboxStatus, datesEqual, findUnlinkedSuggestionsByHash } from "@/lib/sync-comments";
import { parseExtensionTimestamp } from "@/lib/extension-suggestions";
import { isDiscoId } from "@/lib/disco-id";
import { initialReadMessageCount, isThreadRead, nextReadMessageCount } from "@/lib/read-state";
import { CommentStatus, CommentType, DocRole, Prisma, type Comment, type Doc } from "@prisma/client";

/** Shape of a single extension suggestion as received from the API request body. */
export interface ExtensionSuggestionInput {
  id: string;              // disco ID
  suggestionType: string;  // "Replace", "Add", "Delete", or non-text types like "Format"
  status: string;          // "open", "accepted", "rejected"
  oldText: string;
  newText: string;
  description: string;     // Full description for non-text suggestions (e.g. "Format: Bold")
  author: string;
  isMine: boolean;
  timestamp: string;
  originalContentDeleted?: boolean; // true when the anchored text has been deleted from the document
  replies: {
    author: string;
    isMine: boolean;
    timestamp: string;
    text: string;
    html?: string;
    action?: string;
  }[];
}

export interface ExtensionMergeResult {
  merged: number;
  inserted: number;
  updated: number;
  resolved: number;
  /** Suggestions dropped because their disco ID was missing or malformed. */
  skipped: number;
  shouldUnarchive: boolean;
  comments: Comment[];
}

/**
 * Check whether a reply mentions the user's email address.
 * Google Docs @mentions render as `mailto:` links in the HTML.
 */
function replyMentionsEmail(reply: ExtensionSuggestionInput["replies"][number], emailLower: string): boolean {
  const html = reply.html ?? reply.text;
  return html.toLowerCase().includes(emailLower);
}

/**
 * Compute isRead from current suggestion state: if there are replies (including
 * accept/reject actions), the last actor determines read state; otherwise the
 * suggestion's own author does. Mirrors deriveCommentFlags' isRead logic for
 * comments — keeps suggestions consistent with comment behavior so "I was the
 * last to act" reliably marks the row as read.
 */
function computeSuggestionIsRead(
  isMine: boolean,
  replies: ExtensionSuggestionInput["replies"],
): boolean {
  return replies.length > 0 ? replies[replies.length - 1].isMine : isMine;
}

/**
 * Compute mentionedMe, mentionedMeUnreplied, and per-reply flags from extension
 * reply data. Per-reply flags are needed for new-reply-mention detection on
 * existing suggestions (parallels comment sync's replyMentionedMeFlags).
 */
function computeMentionFlags(
  replies: ExtensionSuggestionInput["replies"],
  emailLower: string,
): { mentionedMe: boolean; mentionedMeUnreplied: boolean; replyMentionFlags: boolean[]; replyAuthorMeFlags: boolean[] } {
  const replyMentionFlags = replies.map((r) => !r.action && replyMentionsEmail(r, emailLower));
  const replyAuthorMeFlags = replies.map((r) => r.isMine);
  const mentionedMe = replyMentionFlags.some(Boolean);
  // Suggestions have no top-level @mention (the body is a text change, not a comment)
  const mentionedMeUnreplied = computeMentionedMeUnreplied(false, replyMentionFlags, replyAuthorMeFlags);
  return { mentionedMe, mentionedMeUnreplied, replyMentionFlags, replyAuthorMeFlags };
}

/**
 * For rows the extension has already enriched (disco ID already set), carry the
 * stored `readMessageCount` forward — parallels comment sync's read handling in
 * `buildCommentUpdate` (see `src/lib/read-state.ts` for the counting
 * convention). New replies from other people need no write: the preserved count
 * already compares them as unread, which is what keeps manual Mark
 * read/unread toggles sticky. We gate on reply-count/resolve transitions rather
 * than the `driveModifiedAt` timestamp because extension timestamps are
 * DOM-parsed and imprecise.
 *
 * This is NOT used for the Drive-first / Gmail-first enrichment path. Those
 * rows land here with the schema-default `readMessageCount: 0`, which isn't a
 * real manual toggle worth preserving. The hash-match branch uses the freshly
 * computed count directly, so read-state and unarchive signals still land
 * correctly on the first enrichment — e.g., if Drive sync seeded a suggestion
 * and someone else then replied, the extension picks it up as unread and
 * unarchives the doc; if I seeded it and nothing has happened, it's marked
 * read and the doc stays archived.
 */
function effectiveReadMessageCountForUpdate(
  existing: Pick<Comment, "readMessageCount" | "replyCount" | "resolved">,
  isRead: boolean,
  isResolved: boolean,
  newReplyCount: number,
): number {
  return nextReadMessageCount({
    storedCount: existing.readMessageCount,
    oldReplyCount: existing.replyCount,
    newReplyCount,
    hasActivity: newReplyCount > existing.replyCount || existing.resolved !== isResolved,
    iActedLast: isRead,
  });
}

/**
 * Doc-level unarchive rules for an existing suggestion update. Parallels the
 * three rules in sync-comments.ts (`updateExistingComment`), all gated on
 * `!isRead` so my own activity doesn't resurface an archived doc.
 *
 * Note: callers on the `existingById` path pass the *preserved* `effectiveIsRead`
 * (honoring a manual "mark unread" toggle), while the comment-sync parallel gates
 * on the freshly computed `c.isRead`. Deliberate divergence — a user-triggered
 * unread on a suggestion should be allowed to resurface the doc on the next sync,
 * which matches the intent of the manual toggle.
 */
function suggestionShouldUnarchive(opts: {
  previousStatus: CommentStatus;
  targetStatus: CommentStatus;
  hasNewReplies: boolean;
  isResolved: boolean;
  iResolvedIt: boolean;
  isRead: boolean;
}): boolean {
  if (opts.isRead) return false;

  // 1. Status transitions from non-INBOX to INBOX
  if (opts.previousStatus !== CommentStatus.INBOX && opts.targetStatus === CommentStatus.INBOX) return true;

  // If this sync is archiving the suggestion (e.g., silent-accept on my own
  // suggestion routes it INBOX → ARCHIVED), don't resurface the doc — there's
  // nothing interesting there for the user to look at. Rules 2 and 3 only
  // apply when the suggestion ends up in INBOX.
  if (opts.targetStatus !== CommentStatus.INBOX) return false;

  // 2. Existing INBOX with new replies (unless I resolved/accepted/rejected it myself)
  if (opts.previousStatus === CommentStatus.INBOX && opts.hasNewReplies && !(opts.isResolved && opts.iResolvedIt)) return true;

  // 3. INBOX suggestion is resolved by someone else — mirrors the comment rule
  // at sync-comments.ts, which fires on stable resolved-by-not-me state too
  // (not only on the resolve transition). Re-fires on each sync, but
  // unarchiveDocIfNeeded is idempotent.
  //
  // Accept vs reject is NOT differentiated here — both are "resolved by
  // not-me". The distinction has already been made upstream in
  // computeSuggestionStatusUpdate: a silent accept of my own suggestion
  // routes targetStatus to ARCHIVED (and is blocked by the gate above), while
  // a rejection, or an accept with discussion, leaves targetStatus on INBOX
  // and reaches this rule as "worth surfacing for follow-up".
  if (opts.previousStatus === CommentStatus.INBOX && opts.isResolved && !opts.iResolvedIt) return true;

  return false;
}

/**
 * Compute updated status for an existing suggestion based on new activity,
 * following the same rules as comments (see docs/inbox-states.md).
 * Returns undefined when status should not change.
 *
 * Keep in sync with computeCommentStatus() in sync-comments.ts — the rules
 * here parallel the comment update logic but are adapted for extension data
 * (no assignedToMe, MUTED fast-path is inline).
 */
function computeSuggestionStatusUpdate(
  doc: Doc,
  existing: Pick<Comment, "status" | "replyCount">,
  commentData: { resolved: boolean; isThreadAuthor: boolean; isReplyAuthor: boolean; mentionedMe: boolean; replyCount: number },
  mention: { replyMentionFlags: boolean[]; replyAuthorMeFlags: boolean[] },
  iResolvedIt: boolean,
  lastResolveReply: ExtensionSuggestionInput["replies"][number] | undefined,
): typeof CommentStatus.INBOX | typeof CommentStatus.ARCHIVED | undefined {
  const hasNewReplies = commentData.replyCount > existing.replyCount;
  const newReplyMentionsMe = hasNewReplies &&
    mention.replyMentionFlags.slice(existing.replyCount).some(Boolean);

  // New reply @-mentions me → INBOX (overrides MUTED)
  if (newReplyMentionsMe) return CommentStatus.INBOX;

  // MUTED without new mention → preserve (don't check further).
  // Must be before resolve rules so muted suggestions stay muted even on
  // accept/reject (consistent with comment behavior where the MUTED fast-path
  // fires before computeCommentStatus).
  if (existing.status === CommentStatus.MUTED) return undefined;

  // I accepted/rejected someone else's suggestion → ARCHIVED (parallels iResolvedIt)
  if (commentData.resolved && iResolvedIt && !commentData.isThreadAuthor) return CommentStatus.ARCHIVED;

  // My suggestion was accepted with no discussion replies → ARCHIVED (silent accept,
  // nothing interesting to see). Rejections or threads with replies stay — may need
  // follow-up. Applies regardless of who accepted it.
  if (commentData.resolved && commentData.isThreadAuthor && lastResolveReply?.action === "accept") {
    // Archive if the only reply is the accept action itself (no discussion)
    if (commentData.replyCount <= 1) return CommentStatus.ARCHIVED;
  }

  // Check for new activity
  if (!hasNewReplies) return undefined;

  // With new activity, apply relevance rules
  if (commentData.mentionedMe) return CommentStatus.INBOX;
  if (doc.role === DocRole.AUTHOR) return CommentStatus.INBOX;
  if (commentData.isThreadAuthor) {
    // Only INBOX if someone else replied (not just my own self-replies)
    const newReplies = mention.replyAuthorMeFlags.slice(existing.replyCount);
    if (newReplies.some((me) => !me)) return CommentStatus.INBOX;
  } else if (commentData.isReplyAuthor) {
    // I participated on someone else's suggestion — any activity → INBOX
    return CommentStatus.INBOX;
  }

  return undefined;
}

/**
 * Shape of the per-suggestion field bundle computed from one extension payload.
 * Kept as a local interface so `buildExtensionSuggestionUpdate` can type the
 * existing-vs-new comparison explicitly and catch any drift at compile time.
 */
interface SuggestionCommentData {
  replyCount: number;
  resolved: boolean;
  isThreadAuthor: boolean;
  isReplyAuthor: boolean;
  mentionedMe: boolean;
  mentionedMeUnreplied: boolean;
  driveCreatedAt: Date | null;
  driveModifiedAt: Date | null;
}

/**
 * Build the update payload for an existing suggestion row along with a
 * `changed` flag. Mirrors `buildCommentUpdate` in `sync-comments.ts` — pairing
 * the diff check with the data it builds keeps them from drifting when new
 * columns are added.
 *
 * `googleSuggestionId` is intentionally excluded from both the diff and the
 * data: when the partner-merge branch above salvages an ID onto this row, it
 * does so in its own transaction before we get here, so the DB already has
 * the correct value. Don't add `googleSuggestionId` to `data` without also
 * adding it to `changed`, or a no-op-looking sync after a partner merge could
 * skip persisting it.
 */
function buildExtensionSuggestionUpdate(
  existing: Comment,
  commentData: SuggestionCommentData,
  contentHash: string,
  effectiveReadMessageCount: number,
  newStatus: CommentStatus | undefined,
): { changed: boolean; data: Prisma.CommentUncheckedUpdateInput } {
  const status = newStatus ?? existing.status;
  const changed =
    existing.replyCount !== commentData.replyCount ||
    existing.resolved !== commentData.resolved ||
    existing.isThreadAuthor !== commentData.isThreadAuthor ||
    existing.isReplyAuthor !== commentData.isReplyAuthor ||
    existing.mentionedMe !== commentData.mentionedMe ||
    existing.mentionedMeUnreplied !== commentData.mentionedMeUnreplied ||
    existing.readMessageCount !== effectiveReadMessageCount ||
    existing.status !== status ||
    existing.suggestionContentHash !== contentHash ||
    !datesEqual(existing.driveCreatedAt, commentData.driveCreatedAt) ||
    !datesEqual(existing.driveModifiedAt, commentData.driveModifiedAt);

  const data: Prisma.CommentUncheckedUpdateInput = {
    ...commentData,
    suggestionContentHash: contentHash,
    readMessageCount: effectiveReadMessageCount,
    ...(newStatus ? { status: newStatus } : {}),
  };

  return { changed, data };
}

/**
 * Merge extension-scraped suggestions into the database for a document.
 * Returns the final state of all suggestion Comment records for the doc.
 */
export async function mergeExtensionSuggestions(
  docId: string,
  googleDocId: string,
  suggestions: ExtensionSuggestionInput[],
  userEmail: string,
  doc: Doc,
): Promise<ExtensionMergeResult> {
  const t0 = Date.now();
  let merged = 0;
  let inserted = 0;
  let updated = 0;
  let resolved = 0;
  let shouldUnarchive = false;

  const emailLower = userEmail.toLowerCase();

  // Drop anything without a usable disco ID before it can reach the database.
  // `googleCommentId` is the join key for every later lookup — the disco-ID
  // match below, `findUnlinkedSuggestionsByHash`, the extension's DOM
  // navigation — so a malformed value is worse than a missing one. It can never
  // match anything, yet it makes the row ineligible for the hash merge that
  // would otherwise repair it (that query requires `googleCommentId: null`), so
  // the real suggestion later inserts a duplicate that never reconciles. Worse,
  // an ID-less row looks exactly like a legitimate disco-only row to the
  // partner-merge branch below, which would *delete* the real Docs API row and
  // move its `googleSuggestionId` onto the bogus one.
  //
  // The extension already filters and retries these (see `iterateItems` in
  // `background-injected.js`); this is the backstop that keeps a stale
  // extension build from corrupting stored rows. Skipping is safe because the
  // condition is transient — the next scrape re-sends the suggestion with a
  // real ID and it merges normally.
  const validSuggestions = suggestions.filter((s) => isDiscoId(s.id));
  const skipped = suggestions.length - validSuggestions.length;
  if (skipped > 0) {
    logWarning(`[Suggestions:Ext] ${googleDocId}: skipped ${skipped} suggestion(s) with a missing or malformed disco ID`);
  }

  logInfo(`[Suggestions:Ext] ${googleDocId}: merging ${validSuggestions.length} suggestions from extension`);

  for (const s of validSuggestions) {
    const actionType = gmailActionToSuggestionType(s.suggestionType);
    const { deletedText, insertedText } = extractHashTextsFromExtension(s.suggestionType, s.oldText, s.newText);
    const contentHash = computeSuggestionHash(actionType, deletedText, insertedText);
    const createdAt = parseExtensionTimestamp(s.timestamp);
    const lastReplyTs = s.replies.length > 0
      ? parseExtensionTimestamp(s.replies[s.replies.length - 1].timestamp)
      : null;
    const mention = computeMentionFlags(s.replies, emailLower);

    // Common fields for all DB writes
    const isResolved = s.status === "accepted" || s.status === "rejected";
    const isRead = computeSuggestionIsRead(s.isMine, s.replies);
    // Read count for rows seeded from this payload: messages through my last
    // contribution (see initialReadMessageCount).
    const readMessageCount = initialReadMessageCount(s.isMine, s.replies.map((r) => r.isMine));
    const commentData: SuggestionCommentData = {
      replyCount: s.replies.length,
      resolved: isResolved,
      isThreadAuthor: s.isMine,
      isReplyAuthor: s.replies.some(r => r.isMine),
      mentionedMe: mention.mentionedMe,
      mentionedMeUnreplied: mention.mentionedMeUnreplied,
      driveCreatedAt: createdAt,
      driveModifiedAt: lastReplyTs ?? createdAt,
    };
    // I accepted/rejected it myself — parallels iResolvedIt for comments
    // (uses last accept/reject reply, not any, in case of reopen+re-resolve)
    const lastResolveReply = [...s.replies].reverse().find(r => r.action === "accept" || r.action === "reject");
    const iResolvedIt = isResolved && lastResolveReply?.isMine === true;

    logInfo(`[Suggestions:Ext] ${googleDocId}: processing ${s.id} ${actionType} old=${s.oldText.length}chars new=${s.newText.length}chars status=${s.status} hash=${contentHash.substring(0, 12)}…`);

    // 1. Check if this disco ID already exists — update metadata
    let existingById = await prisma.comment.findFirst({
      where: { docId, googleCommentId: s.id },
    });
    if (existingById && !existingById.googleSuggestionId) {
      // Found by disco ID, but missing suggestion ID. Check if there's a
      // suggestion-only record with the same hash that we should merge with.
      // The partner must actually have a `googleSuggestionId` to contribute;
      // filter defensively so a hash-only row (both IDs null) can't cause us
      // to delete a partner that adds nothing.
      const hashCandidates = (await findUnlinkedSuggestionsByHash(docId, contentHash))
        .filter((c) => c.googleSuggestionId);
      if (hashCandidates.length === 1) {
        const partner = hashCandidates[0];
        logInfo(`[Suggestions:Ext] ${googleDocId}: merging disco-only row ${existingById.commentId} with suggestion-only partner ${partner.commentId} by hash`);
        // We keep the disco-ID record and drop the partner's other columns.
        // The disco-ID record was created by a live source (extension or Gmail)
        // that carries full participation/reply/read state; the partner was
        // written by Docs API sync, which only knows the suggestion's text and
        // type — no author, mention, reply, or read info. So the disco-ID row
        // is strictly richer, and the only field we need to salvage from the
        // partner is `googleSuggestionId`. The metadata update immediately
        // below then refreshes the disco-ID row from the current extension
        // payload, so nothing the partner had is lost.
        await prisma.$transaction(async (tx) => {
          await tx.comment.delete({ where: { commentId: partner.commentId } });
          await tx.comment.update({
            where: { commentId: existingById!.commentId },
            data: { googleSuggestionId: partner.googleSuggestionId },
          });
        });
        existingById.googleSuggestionId = partner.googleSuggestionId;
      }
    }

    if (existingById) {
      if (commentData.resolved && !existingById.resolved) resolved++;
      const newStatus = computeSuggestionStatusUpdate(doc, existingById, commentData, mention, iResolvedIt, lastResolveReply);
      const effectiveReadMessageCount = effectiveReadMessageCountForUpdate(
        existingById, isRead, isResolved, s.replies.length,
      );
      if (suggestionShouldUnarchive({
        previousStatus: existingById.status,
        targetStatus: newStatus ?? existingById.status,
        hasNewReplies: s.replies.length > existingById.replyCount,
        isResolved,
        iResolvedIt,
        isRead: isThreadRead({ readMessageCount: effectiveReadMessageCount, replyCount: s.replies.length }),
      })) shouldUnarchive = true;
      // Skip the DB write when nothing would change — extension re-syncs run on
      // every pane snapshot and most suggestions are unchanged between syncs.
      const { changed, data } = buildExtensionSuggestionUpdate(
        existingById, commentData, contentHash, effectiveReadMessageCount, newStatus,
      );
      if (!changed) continue;
      logInfo(`[Suggestions:Ext] ${googleDocId}: ${s.id} already exists as ${existingById.commentId} — updating metadata`);
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { commentId: existingById.commentId },
          data,
        });
        await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
      });
      updated++;
    } else {
      // 2. Look up by content hash (rows without a googleCommentId — not yet merged from Gmail/extension)
      const candidates = await findUnlinkedSuggestionsByHash(docId, contentHash);

      if (candidates.length === 1) {
        // 3. Unique match — merge extension data into existing Drive-created row.
        // We only merge when there's exactly one candidate to avoid pairing the
        // wrong disco ID with the wrong googleSuggestionId.
        const existing = candidates[0];
        logInfo(`[Suggestions:Ext] ${googleDocId}: merged ${s.id} into ${existing.commentId} by hash`);
        if (commentData.resolved && !existing.resolved) resolved++;
        // This is the first time the extension enriches a Docs API-created row
        // (adding the disco ID). The Docs API had no participation data, so the
        // initial status may be wrong (e.g., ARCHIVED for a suggestion I created
        // on a REVIEWER doc). Re-evaluate with the now-available data.
        let newStatus = computeSuggestionStatusUpdate(doc, existing, commentData, mention, iResolvedIt, lastResolveReply);
        if (!newStatus && existing.status === CommentStatus.ARCHIVED) {
          const shouldBe = computeInitialInboxStatus({
            mentionedOrAssigned: commentData.mentionedMe,
            resolved: commentData.resolved,
            isDocAuthor: doc.role === DocRole.AUTHOR,
            isThreadAuthor: commentData.isThreadAuthor,
            isReplyAuthor: commentData.isReplyAuthor,
          });
          if (shouldBe === CommentStatus.INBOX) newStatus = CommentStatus.INBOX;
        }
        // First enrichment: the Drive/Gmail-first row had no authorship data so
        // its readMessageCount is the schema default (0), not a manual toggle
        // worth preserving. Use the freshly computed value — matches how we
        // re-evaluate status here via computeInitialInboxStatus.
        if (suggestionShouldUnarchive({
          previousStatus: existing.status,
          targetStatus: newStatus ?? existing.status,
          hasNewReplies: s.replies.length > existing.replyCount,
          isResolved,
          iResolvedIt,
          isRead,
        })) shouldUnarchive = true;
        await prisma.$transaction(async (tx) => {
          await tx.comment.update({
            where: { commentId: existing.commentId },
            data: {
              googleCommentId: s.id,
              ...commentData,
              readMessageCount,
              ...(newStatus ? { status: newStatus } : {}),
            },
          });
          await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
        });
        merged++;
      } else {
        // 4. No match, or multiple matches — insert new row (extension-first).
        // Multiple matches are ambiguous — we can't confidently pair a disco ID
        // with a specific googleSuggestionId, so we insert a separate row.
        if (candidates.length > 1) {
          logWarning(`[Suggestions:Ext] ${googleDocId}: ${candidates.length} hash matches for ${s.id} — inserting separate row`);
        } else {
          logInfo(`[Suggestions:Ext] ${googleDocId}: inserted ${s.id} ${actionType} (extension-first)`);
        }
        const status = computeInitialInboxStatus({
          mentionedOrAssigned: commentData.mentionedMe,
          resolved: commentData.resolved || !!s.originalContentDeleted,
          isDocAuthor: doc.role === DocRole.AUTHOR,
          isThreadAuthor: commentData.isThreadAuthor,
          isReplyAuthor: commentData.isReplyAuthor,
        });
        // Don't resurface the doc if I'm the last actor (e.g., I just made my own
        // suggestion) — parallels buildNewComment's `!c.isRead` gate.
        if (status === CommentStatus.INBOX && !isRead) shouldUnarchive = true;
        await prisma.$transaction(async (tx) => {
          await tx.comment.create({
            data: {
              docId,
              googleCommentId: s.id,
              type: CommentType.SUGGESTION,
              suggestionType: actionType,
              suggestionContentHash: contentHash,
              status,
              readMessageCount,
              ...commentData,
            },
          });
          await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
        });
        inserted++;
      }
    }
  }

  // Fetch final state of all suggestion records for this doc
  const comments = await prisma.comment.findMany({
    where: { docId, type: CommentType.SUGGESTION },
    orderBy: [{ googleSuggestionId: "asc" }, { googleCommentId: "asc" }],
  });

  logInfo(`[Suggestions:Ext] ${googleDocId}: done — ${merged} merged, ${inserted} inserted, ${updated} updated, ${resolved} resolved${skipped ? `, ${skipped} skipped` : ""} (${Date.now() - t0}ms)`);

  return { merged, inserted, updated, resolved, skipped, shouldUnarchive, comments };
}

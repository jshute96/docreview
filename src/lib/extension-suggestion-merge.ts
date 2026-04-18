// Merges suggestion data from the Chrome extension (DOM scraping) into the database.
//
// Similar to mergeSuggestionsFromGmail but with extension-specific data:
// - Disco IDs (AAAB format, same as Gmail's discussionId)
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
import { bumpLastCommentActivity, computeInitialInboxStatus, findUnlinkedSuggestionsByHash } from "@/lib/sync-comments";
import { parseExtensionTimestamp } from "@/lib/extension-suggestions";
import { CommentStatus, CommentType, DocRole, type Comment, type Doc } from "@prisma/client";

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

  logInfo(`[Suggestions:Ext] ${googleDocId}: merging ${suggestions.length} suggestions from extension`);

  for (const s of suggestions) {
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
    const commentData = {
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
    const existingById = await prisma.comment.findFirst({
      where: { docId, googleCommentId: s.id },
    });
    if (existingById) {
      logInfo(`[Suggestions:Ext] ${googleDocId}: ${s.id} already exists as ${existingById.commentId} — updating metadata`);
      if (commentData.resolved && !existingById.resolved) resolved++;
      const newStatus = computeSuggestionStatusUpdate(doc, existingById, commentData, mention, iResolvedIt, lastResolveReply);
      if (newStatus === CommentStatus.INBOX && existingById.status !== CommentStatus.INBOX) shouldUnarchive = true;
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { commentId: existingById.commentId },
          data: {
            ...commentData,
            ...(newStatus ? { status: newStatus } : {}),
          },
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
        if (newStatus === CommentStatus.INBOX && existing.status !== CommentStatus.INBOX) shouldUnarchive = true;
        await prisma.$transaction(async (tx) => {
          await tx.comment.update({
            where: { commentId: existing.commentId },
            data: {
              googleCommentId: s.id,
              ...commentData,
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
        if (status === CommentStatus.INBOX) shouldUnarchive = true;
        await prisma.$transaction(async (tx) => {
          await tx.comment.create({
            data: {
              docId,
              googleCommentId: s.id,
              type: CommentType.SUGGESTION,
              suggestionType: actionType,
              suggestionContentHash: contentHash,
              status,
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

  logInfo(`[Suggestions:Ext] ${googleDocId}: done — ${merged} merged, ${inserted} inserted, ${updated} updated, ${resolved} resolved (${Date.now() - t0}ms)`);

  return { merged, inserted, updated, resolved, shouldUnarchive, comments };
}

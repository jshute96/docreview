import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { computeSuggestionHash, gmailActionToSuggestionType, extractHashTextsFromGmail } from "@/lib/suggestion-hash";
import { bumpLastCommentActivity, findUnlinkedSuggestionsByHash } from "@/lib/sync-comments";
import { parseGmailNotificationFromParsed, type ParsedEmail } from "@/lib/parse-gmail-notification";
import { CommentStatus, CommentType } from "@prisma/client";

// Merges suggestion data from a Gmail notification into existing suggestion records
// (created by Drive sync) or creates new records if Gmail arrived first.
//
// For each suggestion in the email:
//   1. Look up by content hash in the doc's suggestion rows.
//   2. If exactly one match: merge in googleCommentId and replyCount (don't overwrite driveCreatedAt).
//   3. If no match: insert a new row (Gmail arrived first — Drive sync will fill in later).
//   4. If multiple matches: skip (ambiguous — safe degradation).
export async function mergeSuggestionsFromGmail(
  docId: string,
  googleDocId: string,
  email: ParsedEmail,
): Promise<{ merged: number; inserted: number; shouldUnarchive: boolean }> {
  let parsed;
  try {
    parsed = parseGmailNotificationFromParsed(email);
  } catch {
    return { merged: 0, inserted: 0, shouldUnarchive: false };
  }

  if (parsed.type !== "comment" || parsed.suggestions.length === 0) {
    return { merged: 0, inserted: 0, shouldUnarchive: false };
  }

  // Fallback timestamp: email date header (when per-suggestion time isn't parseable)
  const emailDate = parsed.date ? new Date(parsed.date) : null;

  let merged = 0;
  let inserted = 0;
  let shouldUnarchive = false;

  for (const suggestion of parsed.suggestions) {
    const actionType = gmailActionToSuggestionType(suggestion.action);
    const { deletedText, insertedText } = extractHashTextsFromGmail(suggestion);
    const contentHash = computeSuggestionHash(actionType, deletedText, insertedText);

    // Check if this suggestion's comment ID is already in the DB (idempotency)
    let existingById: any = null;
    if (suggestion.discussionId) {
      existingById = await prisma.comment.findFirst({
        where: { docId, googleCommentId: suggestion.discussionId },
      });
      if (existingById) {
        // Found by disco ID, but missing suggestion ID. Check if there's a
        // suggestion-only record with the same hash that we should merge with.
        if (!existingById.googleSuggestionId) {
          const hashCandidates = await findUnlinkedSuggestionsByHash(docId, contentHash);
          if (hashCandidates.length === 1) {
            const partner = hashCandidates[0];
            logInfo(`[Suggestions:Gmail] ${googleDocId}: merging disco-only row ${existingById.commentId} with suggestion-only partner ${partner.commentId} by hash`);
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

        // Update the hash in case the formula changed, but don't
        // do a full metadata merge (Drive sync or Extension sync are better sources).
        if (existingById.suggestionContentHash !== contentHash) {
          await prisma.comment.update({
            where: { commentId: existingById.commentId },
            data: { suggestionContentHash: contentHash },
          });
        }
        continue;
      }
    }

    const candidates = await findUnlinkedSuggestionsByHash(docId, contentHash);

    if (candidates.length === 1) {
      // Unique match — merge Gmail data into existing Drive-created row.
      // Gmail timestamp (actual notification time) is more accurate than
      // Drive's doc.lastModifiedInDrive approximation, so overwrite it.
      const gmailTime = suggestion.time ? new Date(suggestion.time) : emailDate;
      logInfo(`[Suggestions:Gmail] ${googleDocId}: merged ${suggestion.discussionId} into ${candidates[0].commentId} by hash`);
      // Gmail notification = interesting activity → promote ARCHIVED to INBOX
      // but respect MUTED (user explicitly silenced this thread).
      const promoteStatus = candidates[0].status === CommentStatus.ARCHIVED ? CommentStatus.INBOX : undefined;
      // Use the last reply's timestamp as driveModifiedAt if available,
      // keeping the later of the existing value and the new one.
      const lastReply = suggestion.replies[suggestion.replies.length - 1];
      const lastReplyTime = lastReply?.time ? new Date(lastReply.time) : null;
      const existingModified = candidates[0].driveModifiedAt?.getTime() ?? 0;
      const newModified = lastReplyTime && lastReplyTime.getTime() > existingModified ? lastReplyTime : undefined;
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { commentId: candidates[0].commentId },
          data: {
            googleCommentId: suggestion.discussionId || null,
            replyCount: Math.max(suggestion.replies.length, candidates[0].replyCount),
            ...(gmailTime ? { driveCreatedAt: gmailTime } : {}),
            ...(newModified ? { driveModifiedAt: newModified } : {}),
            ...(promoteStatus ? { status: promoteStatus } : {}),
          },
        });
        await bumpLastCommentActivity(docId, [gmailTime, newModified], tx);
      });
      if (promoteStatus) shouldUnarchive = true;
      merged++;
    } else if (candidates.length === 0) {
      // No match — Gmail arrived before Drive sync. Insert with what we have.
      logInfo(`[Suggestions:Gmail] ${googleDocId}: inserted ${suggestion.discussionId} ${actionType} (Gmail-first)`);
      const sugCreatedAt = suggestion.time ? new Date(suggestion.time) : emailDate;
      await prisma.$transaction(async (tx) => {
        await tx.comment.create({
          data: {
            docId,
            googleCommentId: suggestion.discussionId || null,
            type: CommentType.SUGGESTION,
            suggestionType: actionType,
            suggestionContentHash: contentHash,
            resolved: false,
            status: CommentStatus.INBOX,
            driveCreatedAt: sugCreatedAt,
            driveModifiedAt: sugCreatedAt,
            replyCount: suggestion.replies.length,
          },
        });
        await bumpLastCommentActivity(docId, [sugCreatedAt], tx);
      });
      shouldUnarchive = true;
      inserted++;
    } else {
      // Multiple matches — ambiguous, skip
      logWarning(`[Suggestions:Gmail] ${googleDocId}: multiple hash matches for ${suggestion.discussionId} — skipping`);
    }
  }

  return { merged, inserted, shouldUnarchive };
}

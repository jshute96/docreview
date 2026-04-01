import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { computeSuggestionHash, gmailActionToSuggestionType } from "@/lib/suggestion-hash";
import { bumpLastCommentActivity } from "@/lib/sync-comments";
import { parseGmailNotificationFromParsed, type ParsedEmail } from "@/lib/parse-gmail-notification";
import type { Suggestion } from "@/lib/parse-gmail-notification";

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
): Promise<{ merged: number; inserted: number }> {
  let parsed;
  try {
    parsed = parseGmailNotificationFromParsed(email);
  } catch {
    return { merged: 0, inserted: 0 };
  }

  if (parsed.type !== "comment" || parsed.suggestions.length === 0) {
    return { merged: 0, inserted: 0 };
  }

  // Fallback timestamp: email date header (when per-suggestion time isn't parseable)
  const emailDate = parsed.date ? new Date(parsed.date) : null;

  let merged = 0;
  let inserted = 0;

  for (const suggestion of parsed.suggestions) {
    const actionType = gmailActionToSuggestionType(suggestion.action);
    const { deletedText, insertedText } = gmailSuggestionTexts(suggestion);
    const contentHash = computeSuggestionHash(actionType, deletedText, insertedText);

    // Check if this suggestion's comment ID is already in the DB (idempotency)
    if (suggestion.discussionId) {
      const existingById = await prisma.comment.findFirst({
        where: { docId, googleCommentId: suggestion.discussionId },
      });
      if (existingById) continue; // Already merged
    }

    // Look up by content hash
    const candidates = await prisma.comment.findMany({
      where: {
        docId,
        type: "SUGGESTION",
        suggestionContentHash: contentHash,
        // Only match rows that don't already have a googleCommentId
        googleCommentId: null,
      },
    });

    if (candidates.length === 1) {
      // Unique match — merge Gmail data into existing Drive-created row.
      // Gmail timestamp (actual notification time) is more accurate than
      // Drive's doc.lastModifiedInDrive approximation, so overwrite it.
      const gmailTime = suggestion.time ? new Date(suggestion.time) : emailDate;
      logInfo(`[Suggestions:Gmail] ${googleDocId}: merged ${suggestion.discussionId} into ${candidates[0].commentId} by hash`);
      // Gmail notification = interesting activity → promote ARCHIVED to INBOX
      // but respect MUTED (user explicitly silenced this thread).
      const promoteStatus = candidates[0].status === "ARCHIVED" ? "INBOX" : undefined;
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
            type: "SUGGESTION",
            suggestionType: actionType,
            suggestionContentHash: contentHash,
            resolved: false,
            status: "INBOX",
            driveCreatedAt: sugCreatedAt,
            driveModifiedAt: sugCreatedAt,
            replyCount: suggestion.replies.length,
          },
        });
        await bumpLastCommentActivity(docId, [sugCreatedAt], tx);
      });
      inserted++;
    } else {
      // Multiple matches — ambiguous, skip
      logWarning(`[Suggestions:Gmail] ${googleDocId}: multiple hash matches for ${suggestion.discussionId} — skipping`);
    }
  }

  return { merged, inserted };
}

// Extracts deleted/inserted text from a Gmail suggestion in the format needed for hashing.
function gmailSuggestionTexts(s: Suggestion): { deletedText: string; insertedText: string } {
  switch (s.action) {
    case "Add":
      return { deletedText: "", insertedText: s.text };
    case "Delete":
      return { deletedText: s.text, insertedText: "" };
    case "Replace":
      return { deletedText: s.oldText ?? "", insertedText: s.newText ?? "" };
    default:
      return { deletedText: s.oldText ?? "", insertedText: s.newText ?? s.text };
  }
}

import { prisma } from "@/lib/prisma";
import { logInfo } from "@/lib/log";
import { bumpLastCommentActivity } from "@/lib/sync-comments";
import { parseGmailNotificationFromParsed, type ParsedEmail } from "@/lib/parse-gmail-notification";

/**
 * Merges comment data from a Gmail notification into the database.
 * Only processes comments when noCommentsPermission is true — these are
 * mentions/assignments in docs where the Drive API can't list comments,
 * so the Gmail notification is the only source.
 *
 * For each comment thread:
 *   1. Check idempotency by googleCommentId (discussion ID).
 *   2. If already exists: skip.
 *   3. If new: insert with INBOX status (mention/assignment = high priority).
 *
 * Safe to call for any doc — if noCommentsPermission is false in the email,
 * or if Drive sync already created the comment, it's a no-op.
 *
 * Protection against Drive sync deleting these comments:
 *   - Inaccessible docs (DENIED/NOT_FOUND) never go through syncComments.
 *   - View-only docs get 403 from comments.list → syncComments returns early.
 *   - If access is later granted, Drive returns the same googleCommentId →
 *     syncDriveComments finds the existing record and updates (no deletion).
 */
export async function mergeCommentsFromGmail(
  docId: string,
  googleDocId: string,
  email: ParsedEmail,
): Promise<{ inserted: number; shouldUnarchive: boolean }> {
  let parsed;
  try {
    parsed = parseGmailNotificationFromParsed(email);
  } catch {
    return { inserted: 0, shouldUnarchive: false };
  }

  if (parsed.type !== "comment" || !parsed.noCommentsPermission || parsed.comments.length === 0) {
    return { inserted: 0, shouldUnarchive: false };
  }

  const emailDate = parsed.date ? new Date(parsed.date) : null;
  let inserted = 0;
  let shouldUnarchive = false;

  for (const thread of parsed.comments) {
    if (!thread.discussionId) continue;

    // Idempotency: skip if this discussion ID is already in the DB
    const existing = await prisma.comment.findFirst({
      where: { docId, googleCommentId: thread.discussionId },
    });
    if (existing) continue;

    // Timestamps from reply data
    const firstReply = thread.replies[0];
    const lastReply = thread.replies[thread.replies.length - 1];
    const createdAt = firstReply?.time ? new Date(firstReply.time) : emailDate;
    const modifiedAt = lastReply?.time ? new Date(lastReply.time) : createdAt;
    // Drive's replyCount excludes the root comment; Gmail replies includes all posts
    const replyCount = Math.max(0, thread.replies.length - 1);

    logInfo(`[Comments:Gmail] ${googleDocId}: inserted comment ${thread.discussionId} (no comment access)`);

    await prisma.$transaction(async (tx) => {
      await tx.comment.create({
        data: {
          docId,
          googleCommentId: thread.discussionId,
          type: "COMMENT",
          resolved: false,
          status: "INBOX",
          mentionedMe: true,
          mentionedMeUnreplied: true,
          assignedToMe: thread.assignedTo === "you",
          isThreadAuthor: false,
          isReplyAuthor: false,
          driveCreatedAt: createdAt,
          driveModifiedAt: modifiedAt,
          replyCount,
        },
      });
      await bumpLastCommentActivity(docId, [createdAt, modifiedAt], tx);
    });

    shouldUnarchive = true;
    inserted++;
  }

  return { inserted, shouldUnarchive };
}

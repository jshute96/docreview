/**
 * Helpers for per-thread read tracking via `readMessageCount`.
 *
 * A thread's messages are the head comment plus its replies, so a thread with
 * `replyCount` replies has `replyCount + 1` messages. `readMessageCount` is how
 * many of those the user has read, counting from the start of the thread:
 * 0 = nothing read, `replyCount + 1` = fully read. There is no Google-side
 * read signal — this is purely Docreview-managed state, advanced by the user's
 * own activity in the thread (sync) or the Mark read/unread buttons.
 *
 * Compare with >= everywhere: deleted replies shrink `replyCount`, so a stored
 * count can exceed the current total.
 */

/** Total messages in a thread: the head comment plus its replies. */
export function totalMessageCount(replyCount: number): number {
  return replyCount + 1;
}

/** Whether every message in the thread has been read. */
export function isThreadRead(c: { readMessageCount: number; replyCount: number }): boolean {
  return c.readMessageCount >= totalMessageCount(c.replyCount);
}

/**
 * The read count to store for a thread that already exists in the DB. Shared by
 * comment sync (`buildCommentUpdate`) and extension suggestion merge, which
 * apply the same rules but compute `hasActivity` differently — Drive has a
 * trustworthy thread timestamp, the extension's DOM-scraped ones are imprecise.
 *
 * - No activity → carry the stored count forward.
 * - I posted the latest message → the whole thread is read.
 * - Someone else's new replies → also carry it forward: leaving the count alone
 *   is what makes exactly the new replies unread, and what makes a manual
 *   "mark unread" survive later replies.
 * - Activity without new replies (an edit, a deleted reply, a resolve flip) →
 *   mark the last message unread. Drive only reports a thread-level
 *   modifiedTime, so we can't tell which message changed; flagging the last one
 *   resurfaces the thread without guessing.
 *
 * The stored count is clamped to the current total first: deleting a reply
 * shrinks the thread, and leftover read credit would otherwise swallow the next
 * real reply.
 */
export function nextReadMessageCount(opts: {
  /** readMessageCount currently in the DB. */
  storedCount: number;
  /** replyCount currently in the DB. */
  oldReplyCount: number;
  /** replyCount reported by this sync. */
  newReplyCount: number;
  /** Whether this sync found activity worth reacting to. */
  hasActivity: boolean;
  /** Whether the user authored the thread's latest message. */
  iActedLast: boolean;
}): number {
  const total = totalMessageCount(opts.newReplyCount);
  const clamped = Math.min(opts.storedCount, total);
  if (!opts.hasActivity) return clamped;
  if (opts.iActedLast) return total;
  if (opts.newReplyCount <= opts.oldReplyCount) return Math.min(clamped, opts.newReplyCount);
  return clamped;
}

/**
 * Initial read count for a thread's first sync: messages up through the user's
 * last contribution, on the reasoning that writing a message implies having
 * read everything before it. A thread the user acted last on is fully read, one
 * they never posted in is fully unread, and one where others replied after them
 * is partially read (my reply followed by two unseen replies seeds as "2 unread").
 */
export function initialReadMessageCount(
  isThreadAuthor: boolean,
  replyAuthorMeFlags: boolean[],
): number {
  for (let i = replyAuthorMeFlags.length - 1; i >= 0; i--) {
    if (replyAuthorMeFlags[i]) return i + 2; // head + replies 0..i
  }
  return isThreadAuthor ? 1 : 0;
}

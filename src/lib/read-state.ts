/**
 * Helpers for per-thread read tracking.
 *
 * There are two ways to number a thread's messages, and keeping them straight
 * is what this module is for:
 *
 * - **Slot space** — the head comment plus every reply slot Drive has ever
 *   returned, deleted replies included. Drive keeps a tombstone for a deleted
 *   reply in its original position (content and author stripped, `deleted: true`),
 *   so slot positions never move and the slot count only ever grows. The stored
 *   read boundary, `readSlotCount`, lives here: 0 = nothing read,
 *   `replySlotCount + 1` = fully read.
 * - **Render space** — the head comment plus the *live* replies, which is what
 *   the thread panel actually draws and what the docs table counts.
 *   `readMessageCount` is the same boundary expressed here, cached alongside it
 *   so the table can count unread without fetching the thread.
 *
 * Storing the boundary in slot space is what stops it sliding: deleting a reply
 * below the boundary used to shift every message after it down one position and
 * silently credit an unread message as read. Because tombstones keep their
 * place, the read messages are still a *prefix* of the rendered ones, so a
 * single number converts between the two spaces — see `renderReadCount` and
 * `slotBoundaryFor`. Nothing above this module needs to do index arithmetic.
 *
 * Sources with no tombstone concept — extension-scraped suggestions, threads
 * synthesized from Gmail notifications — have no deleted slots at all, so the
 * two spaces coincide and every helper here degenerates to the identity.
 *
 * There is no Google-side read signal. This is purely Docreview-managed state,
 * advanced by the user's own activity in the thread (sync) or the Mark
 * read/unread buttons.
 */

/** Total live messages in a thread: the head comment plus its live replies. */
export function totalMessageCount(replyCount: number): number {
  return replyCount + 1;
}

/** Total slots in a thread: the head comment plus every reply slot. */
export function totalSlotCount(replySlotCount: number): number {
  return replySlotCount + 1;
}

/**
 * The render-space read count for a slot-space boundary: how many *live*
 * messages fall below it. The head comment is slot 0 and is always live — a
 * deleted head means Drive dropped the whole thread, so there is no thread to
 * render. Reply slot `i` is slot `i + 1`.
 *
 * `replyDeleted[i]` is whether reply slot `i` is a tombstone.
 */
export function renderReadCount(replyDeleted: boolean[], readSlotCount: number): number {
  if (readSlotCount <= 0) return 0;
  let count = 1; // the head comment
  for (let i = 0; i < replyDeleted.length; i++) {
    if (i + 1 >= readSlotCount) break;
    if (!replyDeleted[i]) count++;
  }
  return count;
}

/**
 * The slot-space boundary for a render-space read count — the inverse of
 * `renderReadCount`. Marking every live message read extends the boundary
 * through any trailing tombstones, so a fully-read thread reads as fully read
 * in slot space too.
 */
export function slotBoundaryFor(replyDeleted: boolean[], renderCount: number): number {
  if (renderCount <= 0) return 0;
  const liveTotal = totalMessageCount(replyDeleted.filter((d) => !d).length);
  // Reading everything means reading to the end of the thread, trailing
  // tombstones included — otherwise a fully-read thread would sit at a boundary
  // short of its slot total, and sync's own "fully read" value wouldn't match.
  if (renderCount >= liveTotal) return totalSlotCount(replyDeleted.length);
  if (renderCount === 1) return 1; // the head comment alone
  let live = 1;
  for (let i = 0; i < replyDeleted.length; i++) {
    if (replyDeleted[i]) continue;
    live++;
    if (live === renderCount) return i + 2; // slots 0..i inclusive
  }
  return totalSlotCount(replyDeleted.length);
}

/** The replies a thread actually draws: tombstones filtered out. Sources with
 *  no tombstone concept pass through unchanged. */
export function liveThreadReplies<T extends { deleted?: boolean }>(replies: T[]): T[] {
  return replies.filter((r) => !r.deleted);
}

/** Per-slot tombstone flags for a fetched thread, in slot order. */
export function replyDeletedFlags<T extends { deleted?: boolean }>(replies: T[]): boolean[] {
  return replies.map((r) => r.deleted === true);
}

/**
 * Messages the user hasn't read yet, counting the head comment — a fully unread
 * thread with no replies has 1. Derived, not stored: only the read boundary is
 * cached, so replies arriving raise this with no write anywhere. Clamped at 0
 * because a stored count can exceed the total after replies are deleted.
 */
export function unreadMessageCount(c: { readMessageCount: number; replyCount: number }): number {
  return Math.max(0, totalMessageCount(c.replyCount) - c.readMessageCount);
}

/** Slot flags for a source that has no tombstones — extension-scraped
 *  suggestions and Gmail-synthesized threads, where slot space and render space
 *  coincide. Lets those paths use the same helpers as Drive sync. */
export function noTombstones(replyCount: number): boolean[] {
  return new Array(replyCount).fill(false);
}

/** Whether every live message in the thread has been read. Compare with `>=`:
 *  a source that revises `replyCount` downward can leave a stored count above
 *  the current total. */
export function isThreadRead(c: { readMessageCount: number; replyCount: number }): boolean {
  return c.readMessageCount >= totalMessageCount(c.replyCount);
}

/**
 * The read boundary to store for a thread that already exists in the DB. Shared
 * by comment sync (`buildCommentUpdate`) and the extension suggestion merge,
 * which apply the same rules but compute `hasActivity` differently — Drive has
 * a trustworthy thread timestamp, the extension's DOM-scraped ones are imprecise.
 *
 * - No activity → carry the stored boundary forward.
 * - I posted the latest message → the whole thread is read.
 * - Someone else's new replies → also carry it forward: leaving the boundary
 *   alone is what makes exactly the new replies unread, and what makes a manual
 *   "mark unread" survive later replies.
 * - Activity without new slots (an edit, a resolve flip) → mark the last *live*
 *   message unread. Drive only reports a thread-level modifiedTime, so we can't
 *   tell which message changed; flagging the last one resurfaces the thread
 *   without guessing.
 *
 * A deletion never reaches here as activity: `updateExistingComment` classifies a
 * deletion with nothing live to replace it as not-activity before calling in (see
 * `deletionOnly` there), so the boundary is carried forward by the no-activity
 * rule. Deciding it there rather than here is deliberate — the same call has to
 * settle whether the comment moves to Inbox, and the two answers must agree.
 *
 * The stored boundary is still clamped to the current slot total. Slot counts
 * are monotonic in every case Drive documents, but Google guarantees no
 * retention period for tombstones — if they were ever purged the clamp is what
 * keeps leftover read credit from swallowing the next real reply.
 */
export function nextReadSlotCount(opts: {
  /** readSlotCount currently in the DB. */
  storedCount: number;
  /** replySlotCount currently in the DB. */
  oldReplySlotCount: number;
  /** Per-slot deleted flags reported by this sync. Its length is the new slot count. */
  replyDeleted: boolean[];
  /** Whether this sync found activity worth reacting to. */
  hasActivity: boolean;
  /** Whether the user authored the thread's latest live message. */
  iActedLast: boolean;
}): number {
  const total = totalSlotCount(opts.replyDeleted.length);
  const clamped = Math.min(opts.storedCount, total);
  if (!opts.hasActivity) return clamped;
  if (opts.iActedLast) return total;
  if (opts.replyDeleted.length <= opts.oldReplySlotCount) {
    const liveTotal = totalMessageCount(opts.replyDeleted.filter((d) => !d).length);
    return Math.min(clamped, slotBoundaryFor(opts.replyDeleted, liveTotal - 1));
  }
  return clamped;
}

/**
 * Initial boundary for a thread's first sync: the slots up through the user's
 * last contribution, on the reasoning that writing a message implies having
 * read everything before it. A thread the user acted last on is fully read, one
 * they never posted in is fully unread, and one where others replied after them
 * is partially read (my reply followed by two unseen replies seeds as "2 unread").
 *
 * `replyAuthorMeFlags` is slot-indexed. A tombstone's author doesn't survive in
 * Drive's response, so its flag is false — correct, since a message that no
 * longer exists is not a contribution the user can be credited with.
 */
export function initialReadSlotCount(
  isThreadAuthor: boolean,
  replyAuthorMeFlags: boolean[],
): number {
  for (let i = replyAuthorMeFlags.length - 1; i >= 0; i--) {
    if (replyAuthorMeFlags[i]) return i + 2; // head + slots 0..i
  }
  return isThreadAuthor ? 1 : 0;
}

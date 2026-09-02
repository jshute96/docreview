// Helpers for deciding whether a comment or reply was edited after posting.
//
// Drive reports a `modifiedTime` at both levels, but they mean different things:
//   - Reply.modifiedTime   — that reply alone; differs from createdTime iff edited.
//   - Comment.modifiedTime — the max across the initial comment AND all its
//     replies, so it moves whenever anyone replies to (or deletes a reply from)
//     the thread, not just when the comment itself is edited.
// The reply case is therefore a direct comparison; the comment case has to be
// inferred (see commentEditedTime).

/** The timestamps these helpers need, at either level. */
interface Timestamps {
  createdTime?: string | null;
  modifiedTime?: string | null;
}

/** Parses an RFC 3339 timestamp, returning null if it isn't a real date.
 *  Threads synthesized from the browser extension carry scraped display strings
 *  rather than Drive timestamps (and never a modifiedTime at all), so entries
 *  from those sources are treated as "not edited". */
function time(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? null : ms;
}

/** Returns when a reply was edited, or null if it was never edited. */
export function replyEditedTime(reply: Timestamps): string | null {
  const modified = time(reply.modifiedTime);
  const created = time(reply.createdTime);
  if (modified == null || created == null) return null;
  return modified > created ? reply.modifiedTime! : null;
}

/** Returns when a thread's initial comment was edited, or null if it wasn't.
 *
 *  Drive gives no per-comment edit time — `Comment.modifiedTime` is the newest
 *  timestamp anywhere in the thread. So we can only conclude the initial comment
 *  was edited when that timestamp is strictly later than every reply's own
 *  timestamps; if a reply accounts for it, the reply explains it and we report
 *  nothing. That makes this conservative: an edit to the comment made before a
 *  later reply is invisible, but we never claim a false edit.
 *
 *  `replies` must be the RAW reply list, INCLUDING deleted replies — deleting a
 *  reply also bumps the comment's modifiedTime, so a caller that filtered them
 *  out first would see an unexplained timestamp and report an edit that never
 *  happened. Any reply missing a usable `modifiedTime` likewise leaves the
 *  timestamp unexplained, so we stay silent there too. */
export function commentEditedTime(
  createdTime: string | undefined | null,
  modifiedTime: string | undefined | null,
  replies: Timestamps[],
): string | null {
  const modified = time(modifiedTime);
  const created = time(createdTime);
  if (modified == null || created == null || modified <= created) return null;
  for (const reply of replies) {
    const replyModified = time(reply.modifiedTime);
    if (replyModified == null) return null;
    if (Math.max(replyModified, time(reply.createdTime) ?? 0) >= modified) return null;
  }
  return modifiedTime!;
}

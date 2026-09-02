/** Deciding which already-read messages an expanded thread folds away.
 *
 *  A thread with unread messages hides the run of read messages between its
 *  head comment and its last read message, so the new activity is what the
 *  reader lands on. Kept out of the component so the boundaries and the
 *  long-message threshold can be unit-tested. */

/** A lone read message is only worth folding away if it's long enough to push
 *  the unread messages down the panel. Two or more always fold — the "N hidden"
 *  line costs less space than they do. */
export const MIN_LINES_TO_HIDE_ONE = 8;

/** Approximate width of one character of the panel's 14px sans-serif body
 *  text. The estimate only has to tell a one-liner from a wall of text. */
const PIXELS_PER_CHARACTER = 7;

/** Rough count of the display lines `text` wraps to in `width` pixels.
 *  Window-width dependent by design: a narrow window wraps more and buries the
 *  unread messages further down. Returns 0 for a width of 0, i.e. before the
 *  panel has been measured. */
export function estimateLines(text: string, width: number): number {
  if (width <= 0) return 0;
  const columns = Math.max(20, Math.floor(width / PIXELS_PER_CHARACTER));
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines += Math.max(1, Math.ceil(paragraph.length / columns));
  }
  return lines;
}

/** The last message index to fold away, or 0 for "fold nothing". The run always
 *  starts at index 1: the head comment stays, since it's what everyone is
 *  replying to, and so does the last read message (index `readCount - 1`), so
 *  the first unread reply has its antecedent on screen.
 *
 *  `readCount` is the stored read-message count and `total` the live message
 *  count (head comment included); the stored count can exceed the live one when
 *  a reply has been deleted, so it's clamped. */
export function foldEnd(
  readCount: number,
  total: number,
  firstReplyText: string,
  width: number,
): number {
  const read = Math.min(readCount, total);
  // Needs something unread to fold towards.
  if (read >= total) return 0;
  const end = read - 2;
  if (end >= 2) return end;
  if (end === 1 && estimateLines(firstReplyText, width) >= MIN_LINES_TO_HIDE_ONE) return 1;
  return 0;
}

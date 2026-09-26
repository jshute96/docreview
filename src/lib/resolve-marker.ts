import type { ThreadReply } from "@/lib/google-drive";

/** Reply actions that close a thread. A suggestion closes with accept/reject. */
const CLOSING_ACTIONS = new Set(["resolve", "accept", "reject"]);

/**
 * Message position (0 = head comment, i + 1 = reply i) that should carry an
 * inferred "(Resolved)" marker, or null for none.
 *
 * A resolved thread normally has a reply whose action says who closed it, and
 * that reply shows the real marker. Some threads have no such reply: suggestions
 * we synthesize without the extension, and threads built from Gmail
 * notifications. For those, tag the last message so the thread's end still says
 * it's resolved. Only the latest action counts, so a thread that was resolved,
 * reopened, and then (per its status) resolved again still gets the marker.
 */
export function inferredResolvedPosition(
  resolved: boolean,
  replies: Pick<ThreadReply, "action">[],
): number | null {
  if (!resolved) return null;
  const lastAction = [...replies].reverse().find((r) => r.action)?.action;
  if (lastAction && CLOSING_ACTIONS.has(lastAction)) return null;
  return replies.length;
}

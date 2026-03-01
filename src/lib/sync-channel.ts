/**
 * This module facilitates real-time, cross-tab synchronization using the Broadcast Channel API.
 * 
 * It allows different browser tabs of the same application to communicate state changes
 * (like label edits, document updates, or Drive refreshes) without requiring a page reload.
 * 
 * Workflow:
 * 1. A state-modifying action (e.g., editing a label) broadcasts a SyncMessage.
 * 2. Other tabs listen for these messages via a useEffect hook and getSyncChannel().
 * 3. Upon receiving a message, tabs either update their local React state directly with
 *    the provided payload or trigger a background refetch for complex data updates.
 */
import type { Label, Comment } from "@prisma/client";
import type { DocWithLabels, DocWithComments } from "@/types";

export const SYNC_CHANNEL = "docreview_sync";

export type SyncMessage =
  | { type: "REFRESH_ALL" }
  | { type: "DOC_UPDATED"; payload: DocWithLabels | DocWithComments }
  | { type: "DOC_ADDED"; payload: DocWithLabels }
  | { type: "LABELS_UPDATED"; payload: Label[] }
  | { type: "LABEL_DELETED"; payload: string }
  | { type: "COMMENT_UPDATED"; payload: { docId: string; comment: Comment } };

let channel: BroadcastChannel | null = null;

export function getSyncChannel() {
  if (typeof window === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(SYNC_CHANNEL);
  }
  return channel;
}

export function broadcastSync(message: SyncMessage) {
  const chan = getSyncChannel();
  if (chan) {
    chan.postMessage(message);
  }
}

"use client";

import { useEffect, useRef, useLayoutEffect } from "react";

const CHANNEL_NAME = "docreview-sync";

export type CrossTabEvent =
  | { type: "docs"; docIds?: string[] }
  | { type: "labels" }
  | { type: "comments"; docId: string; googleCommentId?: string; commentType?: string }
  | { type: "signout" };

/** Payload sent over BroadcastChannel — event data plus optional sender context ID. */
type CrossTabMessage = CrossTabEvent & { fromContextId?: string };

/**
 * Per-tab singleton BroadcastChannel used for both sending and listening.
 *
 * Why a singleton matters: the BroadcastChannel spec delivers messages to every
 * BroadcastChannel object on the same channel name EXCEPT the one that called
 * postMessage(). By using a single shared instance for both broadcastChange()
 * and useCrossTabListener(), the sending tab's own listener never fires — only
 * other tabs receive the message. Without this, creating a separate channel per
 * call would cause same-tab self-delivery (the listener's channel object is
 * different from the sender's), triggering unwanted refetches.
 */
let sharedChannel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (!sharedChannel) sharedChannel = new BroadcastChannel(CHANNEL_NAME);
  return sharedChannel;
}

export function broadcastChange(event: CrossTabEvent, contextId?: string) {
  const ch = getChannel();
  if (!ch) return;
  const message: CrossTabMessage = contextId ? { ...event, fromContextId: contextId } : event;
  ch.postMessage(message);
}

/** Event as received by cross-tab listeners, with optional sender context ID. */
export type CrossTabReceivedEvent = CrossTabEvent & { fromContextId?: string };

/** Build a reason string for server logging from a received cross-tab event. */
export function crossTabReason(event: CrossTabReceivedEvent, receiver: string): string {
  let payload = event.type as string;
  if ("docId" in event && event.docId) {
    payload += ` docId=${event.docId}`;
  } else if ("docIds" in event && event.docIds) {
    payload += ` docIds=[${event.docIds.join(", ")}]`;
  }
  const from = event.fromContextId ? ` from ${event.fromContextId}` : "";
  return `${receiver} got notification${from}: ${payload}`;
}

export function useCrossTabListener(
  handler: (event: CrossTabReceivedEvent) => void,
  debounceMs = 300,
) {
  const handlerRef = useRef(handler);

  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const ch = getChannel();
    if (!ch) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: CrossTabMessage | null = null;

    const listener = (e: MessageEvent<CrossTabMessage>) => {
      pending = e.data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending) handlerRef.current(pending);
        pending = null;
        timer = null;
      }, debounceMs);
    };

    ch.addEventListener("message", listener);

    return () => {
      if (timer) clearTimeout(timer);
      ch.removeEventListener("message", listener);
    };
  }, [debounceMs]);
}

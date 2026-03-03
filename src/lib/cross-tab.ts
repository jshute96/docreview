"use client";

import { useEffect, useRef, useLayoutEffect } from "react";

const CHANNEL_NAME = "docreview-sync";

export type CrossTabEvent =
  | { type: "docs"; docId?: string }
  | { type: "labels" }
  | { type: "comments"; docId: string };

/** Payload sent over BroadcastChannel — event data plus optional sender context ID. */
type CrossTabMessage = CrossTabEvent & { fromContextId?: string };

export function broadcastChange(event: CrossTabEvent, contextId?: string) {
  if (typeof window === "undefined") return;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const message: CrossTabMessage = contextId ? { ...event, fromContextId: contextId } : event;
  ch.postMessage(message);
  ch.close();
}

/** Event as received by cross-tab listeners, with optional sender context ID. */
export type CrossTabReceivedEvent = CrossTabEvent & { fromContextId?: string };

/** Build a reason string for server logging from a received cross-tab event. */
export function crossTabReason(event: CrossTabReceivedEvent): string {
  let reason = `cross-tab: ${event.type}`;
  if ("docId" in event && event.docId) reason += ` docId=${event.docId}`;
  if (event.fromContextId) reason += ` (from ${event.fromContextId})`;
  return reason;
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
    const ch = new BroadcastChannel(CHANNEL_NAME);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: CrossTabMessage | null = null;

    ch.onmessage = (e: MessageEvent<CrossTabMessage>) => {
      pending = e.data;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (pending) handlerRef.current(pending);
        pending = null;
        timer = null;
      }, debounceMs);
    };

    return () => {
      if (timer) clearTimeout(timer);
      ch.close();
    };
  }, [debounceMs]);
}

import { useEffect, useRef, useLayoutEffect } from "react";

const CHANNEL_NAME = "docreview-sync";

export type CrossTabEvent =
  | { type: "docs"; docId?: string }
  | { type: "labels" }
  | { type: "comments"; docId: string };

export function broadcastChange(event: CrossTabEvent) {
  if (typeof window === "undefined") return;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.postMessage(event);
  ch.close();
}

export function useCrossTabListener(
  handler: (event: CrossTabEvent) => void,
  debounceMs = 300,
) {
  const handlerRef = useRef(handler);
  
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: CrossTabEvent | null = null;

    ch.onmessage = (e: MessageEvent<CrossTabEvent>) => {
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

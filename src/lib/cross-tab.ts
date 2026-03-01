import { useEffect, useRef } from "react";

const CHANNEL_NAME = "docreview-sync";

export type CrossTabEvent =
  | { type: "docs" }
  | { type: "labels" }
  | { type: "comments"; docId: string };

export function broadcastChange(event: CrossTabEvent) {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.postMessage(event);
  ch.close();
}

export function useCrossTabListener(handler: (event: CrossTabEvent) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.onmessage = (e: MessageEvent<CrossTabEvent>) => {
      handlerRef.current(e.data);
    };
    return () => ch.close();
  }, []);
}

// Client-side SSE (Server-Sent Events) stream reader and toast handlers.
// Reads the event stream produced by createProgressStream() in sse.ts and
// maps progress events to Sonner toast updates in real time.

"use client";

import { toast } from "sonner";
import { ApiAuthError, generateContextId } from "./api-fetch";
import type { ProgressEvent } from "./progress-events";

const REAUTH_TOAST_ID = "reauth-required";
const CONTEXT_ID_HEADER = "x-context-id";

// Fixed toast IDs so progress updates replace the previous toast in-place
export const PROGRESS_DRIVE = "progress-drive";
export const PROGRESS_GMAIL = "progress-gmail";
export const PROGRESS_SYNC = "progress-sync";

/** Dismiss all progress toasts. */
export function dismissProgressToasts() {
  toast.dismiss(PROGRESS_DRIVE);
  toast.dismiss(PROGRESS_GMAIL);
  toast.dismiss(PROGRESS_SYNC);
}

/**
 * Make a fetch request that reads an SSE progress stream.
 * Calls `onProgress` for each progress event and returns the final result.
 */
export async function fetchWithProgress<T>(
  url: string,
  init: RequestInit & { contextId?: string },
  onProgress: (event: ProgressEvent) => void,
): Promise<T> {
  const { contextId, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  headers.set(CONTEXT_ID_HEADER, contextId || generateContextId());

  const res = await fetch(url, { ...fetchInit, headers });

  if (res.status === 401) {
    toast.error(
      "Google authorization has expired. Please sign out and sign back in to reconnect.",
      { id: REAUTH_TOAST_ID, duration: 15000 },
    );
    throw new ApiAuthError();
  }
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);

  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events (separated by double newlines)
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!; // Keep incomplete event in buffer

    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split("\n");
      let eventType = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!eventType || !data) continue;

      const parsed = JSON.parse(data);
      if (eventType === "progress") {
        onProgress(parsed);
      } else if (eventType === "result") {
        result = parsed;
      } else if (eventType === "error") {
        if (parsed.authExpired) {
          toast.error(
            "Google authorization has expired. Please sign out and sign back in to reconnect.",
            { id: REAUTH_TOAST_ID, duration: 15000 },
          );
          throw new ApiAuthError();
        }
        throw new Error(parsed.message || "Request failed");
      }
    }
  }

  if (result === undefined) throw new Error("No result received");
  return result;
}

/** Default progress-to-toast handler for refresh operations. */
export function handleRefreshProgress(event: ProgressEvent) {
  switch (event.phase) {
    case "drive":
      if (event.status === "reading") {
        toast.loading("Reading changes from Drive...", { id: PROGRESS_DRIVE });
      } else {
        const msg = event.count > 0
          ? `Read ${event.count} changes from Drive`
          : "No new changes from Drive";
        toast.success(msg, { id: PROGRESS_DRIVE, duration: 4000 });
      }
      break;
    case "gmail":
      if (event.status === "reading") {
        toast.loading("Reading changes from Gmail...", { id: PROGRESS_GMAIL });
      } else {
        const msg = event.count > 0
          ? `Read ${event.count} changes from Gmail`
          : "No new changes from Gmail";
        if (event.errorCount && event.errorCount > 0) {
          toast.warning(`${msg} (${event.errorCount} errors)`, { id: PROGRESS_GMAIL, duration: 4000 });
        } else {
          toast.success(msg, { id: PROGRESS_GMAIL, duration: 4000 });
        }
      }
      break;
    case "metadata":
      toast.loading(`Fetching ${event.count} documents...`, { id: PROGRESS_SYNC });
      break;
    case "sync":
      if (event.completed < event.total) {
        toast.loading(`Synced ${event.completed} of ${event.total} documents...`, { id: PROGRESS_SYNC });
      } else {
        toast.success(`Synced ${event.total} documents`, { id: PROGRESS_SYNC, duration: 4000 });
      }
      break;
  }
}

/**
 * Format a refresh/load result into a summary string.
 * Returns empty string if there are no meaningful counts.
 */
export function formatResultParts(data: {
  added?: number;
  updated?: number;
  deleted?: number;
  unarchived?: number;
  errorCount?: number;
}): { summary: string; errorSuffix: string } {
  const parts = [
    (data.added ?? 0) > 0 ? `${data.added} new` : "",
    (data.updated ?? 0) > 0 ? `${data.updated} updated` : "",
    (data.deleted ?? 0) > 0 ? `${data.deleted} deleted` : "",
    (data.unarchived ?? 0) > 0 ? `${data.unarchived} unarchived` : "",
  ].filter(Boolean).join(", ");
  const errorSuffix = (data.errorCount ?? 0) > 0 ? ` (${data.errorCount} errors)` : "";
  return { summary: parts || "no updates", errorSuffix };
}

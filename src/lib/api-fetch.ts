import { toast } from "sonner";

const REAUTH_TOAST_ID = "reauth-required";

/** Messages an expanded thread panel shows in place of the thread when it
 *  can't be displayed. Shared so the two places that set them (the page-level
 *  bulk fetch and the per-row fetch) and the help page stay in sync. */
export const THREAD_LOAD_MESSAGES = {
  authExpired: "Couldn't load comments: Google authorization has expired.",
  failed: "Couldn't load comments from Google Drive.",
  deleted: "This comment no longer exists in Google Drive.",
  forbidden: "Comments not visible on this document.",
} as const;
const CONTEXT_ID_HEADER = "x-context-id";
const CONTEXT_REASON_HEADER = "x-context-reason";

/** Generate an 8-char hex context ID for grouping related API requests. */
export function generateContextId(): string {
  // crypto.randomUUID is available in all modern browsers
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/**
 * Wrapper around fetch() that shows a reauth toast on 401 (expired Google token).
 * Throws on non-ok responses so callers can handle other errors normally.
 * Uses a fixed toast ID to avoid duplicate toasts when multiple requests fail.
 *
 * Pass `contextId` to correlate multiple requests from a single user action
 * in the server log. If not provided, one is generated per request.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit & { contextId?: string; reason?: string },
): Promise<Response> {
  const { contextId, reason, ...fetchInit } = init ?? {};
  const id = contextId ?? generateContextId();
  const headers = new Headers(fetchInit.headers);
  headers.set(CONTEXT_ID_HEADER, id);
  if (reason) headers.set(CONTEXT_REASON_HEADER, reason);

  const res = await fetch(input, { ...fetchInit, headers });
  if (res.status === 401) {
    toast.error("Google authorization has expired. Please sign out and sign back in to reconnect.", {
      id: REAUTH_TOAST_ID,
      duration: 15000,
    });
    throw new ApiAuthError();
  }
  return res;
}

export class ApiAuthError extends Error {
  constructor() {
    super("Google authorization expired");
    this.name = "ApiAuthError";
  }
}

/** Check if an error is an ApiAuthError (reauth toast already shown). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiAuthError;
}

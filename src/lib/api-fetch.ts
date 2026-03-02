import { toast } from "sonner";

const REAUTH_TOAST_ID = "reauth-required";

/**
 * Wrapper around fetch() that shows a reauth toast on 401 (expired Google token).
 * Throws on non-ok responses so callers can handle other errors normally.
 * Uses a fixed toast ID to avoid duplicate toasts when multiple requests fail.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
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

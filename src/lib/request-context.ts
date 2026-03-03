import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logSilent } from "./log";

const requestIdStore = new AsyncLocalStorage<string>();

const CONTEXT_ID_HEADER = "x-context-id";

interface RequestLike {
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

/** Run `fn` in a request context. Extracts the URL and client context ID
 *  from the request; generates a new 8-char hex ID if none provided. */
export function runWithRequestId<T>(method: string, req: RequestLike, fn: () => T): T {
  const id = req.headers.get(CONTEXT_ID_HEADER) || randomUUID().replace(/-/g, "").slice(0, 8);
  return requestIdStore.run(id, () => {
    logSilent(`[API] ${method} ${req.nextUrl.pathname}`);
    return fn();
  });
}

/** Return the current request ID, or "--------" if outside a request context. */
export function getRequestId(): string {
  return requestIdStore.getStore() ?? "--------";
}

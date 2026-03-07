import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logSilent } from "./log";

// --- Per-request context tracking via AsyncLocalStorage ---
//
// We assign an 8-char hex context ID to every incoming API request. The ID
// is either forwarded from the client (via the x-context-id header, so a
// single user action that triggers multiple fetches can share one ID) or
// generated server-side for requests that don't supply one.
//
// AsyncLocalStorage makes the ID available to any code running in the same
// async chain — no need to pass it through function arguments. Each
// concurrent request gets its own isolated value, so this is safe even when
// multiple requests are in-flight at the same time.
//
// The store instance is cached on globalThis so it survives Next.js HMR
// reloads in dev mode.  Without this, HMR re-evaluates this module and
// creates a new AsyncLocalStorage instance, but the Prisma client (also
// cached on globalThis) still holds a closure over getRequestId from the
// previous module evaluation — reading from a now-empty store and always
// returning "--------".

const CONTEXT_ID_HEADER = "x-context-id";
const CONTEXT_REASON_HEADER = "x-context-reason";

interface RequestContext {
  requestId: string;
  userId?: string;
}

const globalForStore = globalThis as unknown as {
  _requestIdStore: AsyncLocalStorage<RequestContext> | undefined;
};

const requestIdStore =
  globalForStore._requestIdStore ?? new AsyncLocalStorage<RequestContext>();

if (process.env.NODE_ENV !== "production")
  globalForStore._requestIdStore = requestIdStore;

interface RequestLike {
  nextUrl: { pathname: string };
  headers: { get(name: string): string | null };
}

/** Wrap an API route handler so all code inside `fn` — including Prisma
 *  queries, Drive API calls, etc. — can retrieve the context ID via
 *  getRequestId() without needing it passed as an argument. */
export function runWithRequestId<T>(method: string, req: RequestLike, fn: () => T): T {
  const id = req.headers.get(CONTEXT_ID_HEADER) || randomUUID().replace(/-/g, "").slice(0, 8);
  const reason = req.headers.get(CONTEXT_REASON_HEADER);
  return requestIdStore.run({ requestId: id }, () => {
    if (reason) logSilent(`[CrossTab] ${reason}`);
    logSilent(`[API] ${method} ${req.nextUrl.pathname}`);
    return fn();
  });
}

/** Return the current request's context ID, or "--------" if called
 *  outside a request (e.g. during server startup). */
export function getRequestId(): string {
  return requestIdStore.getStore()?.requestId ?? "--------";
}

/** Set the user ID for the current request context (call after session is resolved). */
export function setRequestUserId(userId: string): void {
  const ctx = requestIdStore.getStore();
  if (ctx) ctx.userId = userId;
}

/** Return the current request's user ID, or undefined if not set. */
export function getRequestUserId(): string | undefined {
  return requestIdStore.getStore()?.userId;
}

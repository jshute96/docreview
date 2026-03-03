import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logSilent } from "./log";

const requestIdStore = new AsyncLocalStorage<string>();

/** Run `fn` in a context tagged with a short request ID (8 hex chars). */
export function runWithRequestId<T>(label: string, fn: () => T): T {
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  return requestIdStore.run(id, () => {
    logSilent(`[API] ${label}`);
    return fn();
  });
}

/** Return the current request ID, or "-" if outside a request context. */
export function getRequestId(): string {
  return requestIdStore.getStore() ?? "-";
}

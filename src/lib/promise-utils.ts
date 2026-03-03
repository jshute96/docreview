import { logInfo } from "./log";
import { getRequestId } from "./request-context";

/** Wraps a promise and logs a progress message every `intervalMs` (default 5s)
 *  if it hasn't resolved yet. */
export async function withProgressLogging<T>(
  promise: Promise<T>,
  message: string,
  intervalMs: number = 5000
): Promise<T> {
  const start = Date.now();
  const requestId = getRequestId();
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    // Pass requestId explicitly since AsyncLocalStorage context is lost in setInterval
    logInfo(`${message} (running for ${elapsed}s so far...)`, { _reqId: requestId });
  }, intervalMs);

  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

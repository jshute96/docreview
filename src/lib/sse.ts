// SSE (Server-Sent Events) streaming for long-running API operations.
//
// SSE is a standard HTTP mechanism where the server keeps the response open
// and sends a series of text events over time. Each event has a type and
// JSON data, separated by double newlines:
//
//   event: progress
//   data: {"phase":"drive","status":"reading"}
//
//   event: result
//   data: {"added":2,"updated":3}
//
// The client reads these as they arrive using the fetch ReadableStream API,
// which lets us update toasts in real time as each phase completes.

import { invalidGrantResponse } from "./google-drive";
import { logError, logWarning } from "./log";
import type { OnProgress, ProgressEvent } from "./progress-events";

/**
 * Create an SSE streaming response that sends progress events during a
 * long-running operation, then sends the final result.
 *
 * The `execute` function receives a `send` callback to emit progress events.
 * It should return the final result object, which is sent as a "result" event.
 *
 * Auth errors (invalid_grant) are detected and sent as error events with
 * `authExpired: true` so the client can show the reauth toast.
 */
export function createProgressStream(
  execute: (send: OnProgress) => Promise<unknown>,
): Response {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  function write(eventType: string, data: unknown) {
    try {
      controller.enqueue(
        encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    } catch {
      // Stream already closed (client disconnected)
    }
  }

  (async () => {
    try {
      const result = await execute((event: ProgressEvent) => write("progress", event));
      write("result", result);
    } catch (err) {
      if (invalidGrantResponse(err)) {
        logWarning("[SSE] Google authorization expired during streaming");
        write("error", { authExpired: true });
      } else {

        logError("[SSE] Error during streaming operation:", err);
        write("error", { message: err instanceof Error ? err.message : "Unknown error" });
      }
    } finally {
      try {
        controller.close();
      } catch {
        // Already closed
      }
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

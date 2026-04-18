import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithRequestId } from "./request-context";

// In NODE_ENV=test the log file stream is disabled (ensureStream returns null),
// so these tests only validate the console side of the helpers. That's the
// behavior users actually see in their terminal; file-format correctness is
// covered by visual inspection of logs/docreview-*.log.

import { logError, logWarning, logInfo, logSilent } from "./log";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("logError", () => {
  it("prints red ERROR prefix via console.error", () => {
    logError("[Drive] boom");
    expect(errorSpy).toHaveBeenCalledWith(`${RED}ERROR: [Drive] boom${RESET}`);
  });

  it("forwards extra args to console.error", () => {
    const err = new Error("bad");
    logError("[Drive] failed", err, { code: 502 });
    expect(errorSpy).toHaveBeenCalledWith(`${RED}ERROR: [Drive] failed${RESET}`, err, { code: 502 });
  });
});

describe("logWarning", () => {
  it("prints yellow WARNING prefix via console.warn", () => {
    logWarning("[Sync] slow");
    expect(warnSpy).toHaveBeenCalledWith(`${YELLOW}WARNING: [Sync] slow${RESET}`);
  });

  it("forwards extra args to console.warn", () => {
    logWarning("[Sync] slow", 1234);
    expect(warnSpy).toHaveBeenCalledWith(`${YELLOW}WARNING: [Sync] slow${RESET}`, 1234);
  });
});

describe("logInfo", () => {
  it("prints via console.log without a level prefix", () => {
    logInfo("[Drive] ok");
    expect(logSpy).toHaveBeenCalledWith("[Drive] ok");
  });

  it("forwards extra args to console.log", () => {
    logInfo("[Drive] fetched", { count: 5 });
    expect(logSpy).toHaveBeenCalledWith("[Drive] fetched", { count: 5 });
  });

  it("strips the trailing { _reqId } marker before logging to console", () => {
    logInfo("[Drive] with ctx", { count: 5 }, { _reqId: "abc12345" });
    expect(logSpy).toHaveBeenCalledWith("[Drive] with ctx", { count: 5 });
    // the _reqId object must not leak into the console call
    expect(logSpy.mock.calls[0]).not.toContainEqual({ _reqId: "abc12345" });
  });

  it("handles a sole _reqId marker with no other args", () => {
    logInfo("[Drive] ping", { _reqId: "abc12345" });
    expect(logSpy).toHaveBeenCalledWith("[Drive] ping");
  });
});

describe("logSilent", () => {
  it("does not call any console method", () => {
    logSilent("[Server] background work");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("request context integration", () => {
  it("does not throw when called inside runWithRequestId", () => {
    const req = {
      nextUrl: { pathname: "/api/test" },
      headers: { get: () => null },
    };
    // runWithRequestId internally calls logSilent (no console output), and
    // every nested log call picks up the request ID for file output.
    expect(() =>
      runWithRequestId("GET", req, () => {
        logInfo("[API] inside request");
      }),
    ).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith("[API] inside request");
  });
});

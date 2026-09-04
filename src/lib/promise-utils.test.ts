import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withProgressLogging } from "./promise-utils";
import { logInfo } from "./log";

vi.mock("./log", () => ({
  logInfo: vi.fn(),
}));

vi.mock("./request-context", () => ({
  getRequestId: vi.fn(() => "test-id"),
}));

describe("withProgressLogging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("should log progress every interval with the correct request ID", async () => {
    // Create a promise that we can control
    let resolvePromise: (value: string) => void = () => {};
    const slowPromise = new Promise<string>((resolve) => {
      resolvePromise = resolve;
    });

    const resultPromise = withProgressLogging(slowPromise, "Test Task", 5000);

    // Fast-forward 5s
    await vi.advanceTimersByTimeAsync(5000);
    expect(logInfo).toHaveBeenCalledWith(
      "Test Task (running for 5s so far...)",
      { _reqId: "test-id" }
    );

    // Fast-forward another 5s
    await vi.advanceTimersByTimeAsync(5000);
    expect(logInfo).toHaveBeenCalledWith(
      "Test Task (running for 10s so far...)",
      { _reqId: "test-id" }
    );

    // Complete the promise
    resolvePromise("done");
    const result = await resultPromise;

    expect(result).toBe("done");
    
    // Should stop logging after completion
    await vi.advanceTimersByTimeAsync(5000);
    expect(logInfo).toHaveBeenCalledTimes(2);
  });

  it("should not log if promise completes before interval", async () => {
    const fastPromise = Promise.resolve("quick");
    const result = await withProgressLogging(fastPromise, "Fast Task", 5000);

    expect(result).toBe("quick");
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("should clean up timer on error", async () => {
    let rejectPromise: (reason: any) => void = () => {};
    const errorPromise = new Promise((_, reject) => {
      rejectPromise = reject;
    });

    const p = withProgressLogging(errorPromise, "Fail Task", 5000);
    
    rejectPromise(new Error("fail"));
    await expect(p).rejects.toThrow("fail");
    
    await vi.advanceTimersByTimeAsync(10000);
    expect(logInfo).not.toHaveBeenCalled();
  });
});

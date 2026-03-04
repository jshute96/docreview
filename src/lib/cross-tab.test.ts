import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mockPostMessage: ReturnType<typeof vi.fn>;
let mockClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockPostMessage = vi.fn();
  mockClose = vi.fn();

  // Use a function constructor so `new BroadcastChannel(...)` works
  function MockBroadcastChannel() {
    // @ts-expect-error - mock
    this.postMessage = mockPostMessage;
    // @ts-expect-error - mock
    this.close = mockClose;
    // @ts-expect-error - mock
    this.addEventListener = vi.fn();
    // @ts-expect-error - mock
    this.removeEventListener = vi.fn();
    // @ts-expect-error - mock
    this.onmessage = null;
  }

  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  // Ensure window exists for non-SSR tests
  if (typeof globalThis.window === "undefined") {
    vi.stubGlobal("window", {});
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("broadcastChange", () => {
  it("posts message on shared singleton (no close)", async () => {
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs" });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "docs" });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it("includes docId when provided", async () => {
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs", docId: "abc123" });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "docs", docId: "abc123" });
  });

  it("reuses the same BroadcastChannel instance across calls", async () => {
    let ctorCount = 0;
    function CountingChannel() {
      ctorCount++;
      // @ts-expect-error - mock
      this.postMessage = vi.fn();
      // @ts-expect-error - mock
      this.close = vi.fn();
      // @ts-expect-error - mock
      this.addEventListener = vi.fn();
      // @ts-expect-error - mock
      this.removeEventListener = vi.fn();
    }
    vi.stubGlobal("BroadcastChannel", CountingChannel);
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs" });
    broadcastChange({ type: "labels" });
    broadcastChange({ type: "comments", docId: "x" });
    expect(ctorCount).toBe(1);
  });

  it("is a no-op during SSR (no window)", async () => {
    // Remove window to simulate SSR
    // @ts-expect-error - simulating SSR
    delete globalThis.window;
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs" });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

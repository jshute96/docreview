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
  it("posts message and closes channel", async () => {
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs" });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "docs" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("includes docId when provided", async () => {
    const { broadcastChange } = await import("./cross-tab");
    broadcastChange({ type: "docs", docId: "abc123" });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "docs", docId: "abc123" });
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

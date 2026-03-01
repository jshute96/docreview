import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock BroadcastChannel
class MockBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => any) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();

  constructor(name: string) {
    this.name = name;
  }
}

describe("sync-channel", () => {
  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    vi.stubGlobal("window", {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getSyncChannel returns a BroadcastChannel in browser environment", async () => {
    const { getSyncChannel } = await import("./sync-channel");
    const channel = getSyncChannel();
    expect(channel).toBeInstanceOf(MockBroadcastChannel);
    expect(channel?.name).toBe("docreview_sync");
  });

  it("broadcastSync calls postMessage on the channel", async () => {
    const { broadcastSync, getSyncChannel } = await import("./sync-channel");
    const message = { type: "REFRESH_ALL" } as const;
    broadcastSync(message);
    
    const channel = getSyncChannel() as unknown as MockBroadcastChannel;
    expect(channel.postMessage).toHaveBeenCalledWith(message);
  });

  it("returns null when window is undefined (SSR)", async () => {
    vi.stubGlobal("window", undefined);
    const { getSyncChannel } = await import("./sync-channel");
    const channel = getSyncChannel();
    expect(channel).toBeNull();
  });
});

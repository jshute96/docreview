import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// offline.ts reads process.env at module load, so we reset the module cache
// between tests to re-read with fresh env values.

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.OFFLINE_MODE;
  delete process.env.OFFLINE_USER_ID;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("OFFLINE_MODE", () => {
  it("is false when env var is unset", async () => {
    const { OFFLINE_MODE } = await import("./offline");
    expect(OFFLINE_MODE).toBe(false);
  });

  it("is true only when env var is exactly 'true'", async () => {
    process.env.OFFLINE_MODE = "true";
    const { OFFLINE_MODE } = await import("./offline");
    expect(OFFLINE_MODE).toBe(true);
  });

  it("is false for truthy-looking values other than 'true'", async () => {
    process.env.OFFLINE_MODE = "1";
    const { OFFLINE_MODE } = await import("./offline");
    expect(OFFLINE_MODE).toBe(false);
  });
});

describe("OFFLINE_USER_ID", () => {
  it("is null when env var is unset", async () => {
    const { OFFLINE_USER_ID } = await import("./offline");
    expect(OFFLINE_USER_ID).toBeNull();
  });

  it("returns the env value when set", async () => {
    process.env.OFFLINE_USER_ID = "abc123";
    const { OFFLINE_USER_ID } = await import("./offline");
    expect(OFFLINE_USER_ID).toBe("abc123");
  });
});

describe("FALLBACK_OFFLINE_USER", () => {
  it("has the expected identity shape", async () => {
    const { FALLBACK_OFFLINE_USER } = await import("./offline");
    expect(FALLBACK_OFFLINE_USER).toEqual({
      id: "offline-user",
      email: "offline@localhost",
      name: "Offline User",
    });
  });
});

describe("OfflineModeError", () => {
  it("includes the operation name and a clear explanation", async () => {
    const { OfflineModeError } = await import("./offline");
    const err = new OfflineModeError("getDriveClient");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OfflineModeError");
    expect(err.message).toContain("getDriveClient");
    expect(err.message).toContain("offline mode");
    expect(err.message).toContain("OFFLINE_MODE=true");
  });
});

describe("getExpectedOfflineId", () => {
  it("returns null when OFFLINE_MODE is false", async () => {
    const { getExpectedOfflineId } = await import("./offline");
    expect(getExpectedOfflineId()).toBeNull();
  });

  it("returns fallback id when offline and no OFFLINE_USER_ID", async () => {
    process.env.OFFLINE_MODE = "true";
    const { getExpectedOfflineId, FALLBACK_OFFLINE_USER } = await import("./offline");
    expect(getExpectedOfflineId()).toBe(FALLBACK_OFFLINE_USER.id);
  });

  it("returns the configured OFFLINE_USER_ID when offline with override", async () => {
    process.env.OFFLINE_MODE = "true";
    process.env.OFFLINE_USER_ID = "my-offline-id";
    const { getExpectedOfflineId } = await import("./offline");
    expect(getExpectedOfflineId()).toBe("my-offline-id");
  });
});

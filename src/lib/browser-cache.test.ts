import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCached,
  setCached,
  getCachedBatch,
  setCachedBatch,
  touchCached,
  removeCached,
  clearAll,
  evictStale,
} from "./browser-cache";

// The cache talks to localStorage, which doesn't exist in the node test env.
// Back it with a simple in-memory Map mock supporting the subset used here.
class LocalStorageMock {
  store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(i: number): string | null {
    return [...this.store.keys()][i] ?? null;
  }
  clear(): void {
    this.store.clear();
  }
}

let mock: LocalStorageMock;

beforeEach(() => {
  mock = new LocalStorageMock();
  vi.stubGlobal("localStorage", mock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const USER = "user1";
const NS = "meta";

describe("setCached / getCached", () => {
  it("round-trips a value with syncedAt and a cachedAt stamp", () => {
    setCached(USER, NS, "docA", { title: "Hello" }, "2026-01-01T00:00:00.000Z");
    const entry = getCached<{ title: string }>(USER, NS, "docA");
    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual({ title: "Hello" });
    expect(entry!.syncedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof entry!.cachedAt).toBe("string");
  });

  it("namespaces the key as docr:{user}:{namespace}:{id}", () => {
    setCached(USER, NS, "docA", 1, "2026-01-01T00:00:00.000Z");
    expect(mock.getItem("docr:user1:meta:docA")).not.toBeNull();
  });

  it("scopes entries by user and namespace", () => {
    setCached(USER, NS, "docA", "a", "2026-01-01T00:00:00.000Z");
    expect(getCached("user2", NS, "docA")).toBeNull();
    expect(getCached(USER, "other", "docA")).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(getCached(USER, NS, "nope")).toBeNull();
  });

  it("returns null for a corrupt (non-JSON) entry", () => {
    mock.setItem("docr:user1:meta:bad", "{not json");
    expect(getCached(USER, NS, "bad")).toBeNull();
  });

  it("swallows a QuotaExceededError on write (cache is best-effort)", () => {
    vi.spyOn(mock, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => setCached(USER, NS, "docA", "a", "2026-01-01T00:00:00.000Z")).not.toThrow();
  });
});

describe("getCachedBatch / setCachedBatch", () => {
  it("writes and reads many entries, omitting misses", () => {
    setCachedBatch(USER, NS, {
      docA: { value: "a", syncedAt: "2026-01-01T00:00:00.000Z" },
      docB: { value: "b", syncedAt: "2026-01-02T00:00:00.000Z" },
    });
    const batch = getCachedBatch<string>(USER, NS, ["docA", "docB", "docC"]);
    expect(Object.keys(batch).sort()).toEqual(["docA", "docB"]);
    expect(batch.docA.value).toBe("a");
    expect(batch.docB.syncedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("touchCached", () => {
  it("refreshes cachedAt only after the 24h touch interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setCached(USER, NS, "docA", "a", "2026-01-01T00:00:00.000Z");
    const original = getCached(USER, NS, "docA")!.cachedAt;

    // Less than 24h later — no refresh.
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    touchCached(USER, NS, "docA");
    expect(getCached(USER, NS, "docA")!.cachedAt).toBe(original);

    // More than 24h later — cachedAt is bumped.
    vi.setSystemTime(new Date("2026-01-02T06:00:00.000Z"));
    touchCached(USER, NS, "docA");
    expect(getCached(USER, NS, "docA")!.cachedAt).toBe("2026-01-02T06:00:00.000Z");
  });

  it("is a no-op for a missing key", () => {
    expect(() => touchCached(USER, NS, "nope")).not.toThrow();
    expect(mock.length).toBe(0);
  });
});

describe("removeCached", () => {
  it("removes a single entry and leaves others intact", () => {
    setCached(USER, NS, "docA", "a", "2026-01-01T00:00:00.000Z");
    setCached(USER, NS, "docB", "b", "2026-01-01T00:00:00.000Z");
    removeCached(USER, NS, "docA");
    expect(getCached(USER, NS, "docA")).toBeNull();
    expect(getCached(USER, NS, "docB")).not.toBeNull();
  });
});

describe("clearAll", () => {
  it("removes every docr: entry and reports counts, sparing unrelated keys", () => {
    setCached(USER, NS, "docA", "a", "2026-01-01T00:00:00.000Z");
    setCached("user2", "other", "docB", "b", "2026-01-01T00:00:00.000Z");
    mock.setItem("unrelated-key", "keep me");

    const result = clearAll();
    expect(result).toEqual({ removed: 2, found: 2 });
    expect(mock.getItem("unrelated-key")).toBe("keep me");
    expect(getCached(USER, NS, "docA")).toBeNull();
  });
});

describe("evictStale", () => {
  it("evicts entries older than the cutoff across all namespaces for the user", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setCached(USER, "meta", "old", "x", "2026-01-01T00:00:00.000Z");
    setCached(USER, "title", "alsoOld", "y", "2026-01-01T00:00:00.000Z"); // retired namespace

    // 10 days later, write a fresh entry, then evict anything older than 7 days.
    vi.setSystemTime(new Date("2026-01-11T00:00:00.000Z"));
    setCached(USER, "meta", "fresh", "z", "2026-01-11T00:00:00.000Z");

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const evicted = evictStale(USER, "meta", sevenDays);

    expect(evicted).toBe(2);
    expect(getCached(USER, "meta", "old")).toBeNull();
    expect(getCached(USER, "title", "alsoOld")).toBeNull();
    expect(getCached(USER, "meta", "fresh")).not.toBeNull();
  });

  it("does not touch entries belonging to other users", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setCached("user2", "meta", "old", "x", "2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const evicted = evictStale(USER, "meta", 1000);

    expect(evicted).toBe(0);
    expect(getCached("user2", "meta", "old")).not.toBeNull();
  });

  it("evicts corrupt entries for the user", () => {
    mock.setItem("docr:user1:meta:corrupt", "{bad json");
    const evicted = evictStale(USER, "meta", 1000);
    expect(evicted).toBe(1);
    expect(mock.getItem("docr:user1:meta:corrupt")).toBeNull();
  });
});

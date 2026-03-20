/**
 * Browser localStorage cache for data we don't want to store on the server
 * (e.g., doc titles, comment text) but want to show immediately while
 * fresh data loads from Google APIs.
 *
 * Keys are namespaced: docr:{userId}:{namespace}:{id}
 * Values are JSON: { value: T, syncedAt: string, cachedAt: number }
 *
 * The syncedAt timestamp lets the client skip re-fetching when the server's
 * last-refresh timestamp hasn't changed.
 */

const PREFIX = "docr";

function cacheKey(userId: string, namespace: string, id: string): string {
  return `${PREFIX}:${userId}:${namespace}:${id}`;
}

export interface CacheEntry<T> {
  value: T;
  syncedAt: string; // ISO timestamp from server (e.g., lastModifiedInDrive) — used for staleness detection
  cachedAt: string; // ISO timestamp when this entry was written — used for eviction
}

/** Read a single cached value. Returns null if missing or corrupt. */
export function getCached<T>(userId: string, namespace: string, id: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId, namespace, id));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a single cached value. */
export function setCached<T>(userId: string, namespace: string, id: string, value: T, syncedAt: string): void {
  try {
    localStorage.setItem(cacheKey(userId, namespace, id), JSON.stringify({ value, syncedAt, cachedAt: new Date().toISOString() }));
  } catch {
    // QuotaExceededError or other — silently ignore, cache is best-effort
  }
}

/** Read cached values for multiple IDs at once. */
export function getCachedBatch<T>(userId: string, namespace: string, ids: string[]): Record<string, CacheEntry<T>> {
  const result: Record<string, CacheEntry<T>> = {};
  for (const id of ids) {
    const entry = getCached<T>(userId, namespace, id);
    if (entry) result[id] = entry;
  }
  return result;
}

/** Write cached values for multiple IDs at once. */
export function setCachedBatch<T>(userId: string, namespace: string, entries: Record<string, { value: T; syncedAt: string }>): void {
  for (const [id, entry] of Object.entries(entries)) {
    setCached(userId, namespace, id, entry.value, entry.syncedAt);
  }
}

const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Update cachedAt on a cache hit if it's been more than 24h, to keep active entries alive for eviction purposes. */
export function touchCached(userId: string, namespace: string, id: string): void {
  try {
    const key = cacheKey(userId, namespace, id);
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const entry = JSON.parse(raw);
    const cachedTime = entry.cachedAt ? new Date(entry.cachedAt).getTime() : 0;
    if (Date.now() - cachedTime > TOUCH_INTERVAL_MS) {
      entry.cachedAt = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(entry));
    }
  } catch {
    // ignore
  }
}

/** Remove a single cached entry. */
export function removeCached(userId: string, namespace: string, id: string): void {
  try {
    localStorage.removeItem(cacheKey(userId, namespace, id));
  } catch {
    // ignore
  }
}

/**
 * Evict cache entries for a namespace that haven't been written since `cutoffMs` ago.
 * Uses `cachedAt` (when the entry was written), falling back to `syncedAt` for
 * entries written before `cachedAt` was added.
 */
export function evictStale(userId: string, namespace: string, cutoffMs: number): number {
  const prefixStr = `${PREFIX}:${userId}:${namespace}:`;
  const cutoffDate = Date.now() - cutoffMs;
  let evicted = 0;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefixStr)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const entry: CacheEntry<unknown> = JSON.parse(raw);
        const entryTime = entry.cachedAt ? new Date(entry.cachedAt).getTime() : new Date(entry.syncedAt).getTime();
        if (entryTime < cutoffDate) {
          keysToRemove.push(key);
        }
      } catch {
        keysToRemove.push(key); // corrupt entry, remove it
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
      evicted++;
    }
  } catch {
    // ignore
  }
  return evicted;
}

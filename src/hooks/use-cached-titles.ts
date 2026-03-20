"use client";

import { useState, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import type { CacheEntry } from "@/lib/browser-cache";
import { getCachedBatch, setCachedBatch, evictStale, touchCached } from "@/lib/browser-cache";
import { apiFetch } from "@/lib/api-fetch";

const NAMESPACE = "title";
const BATCH_SIZE = 100;
const EVICT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

declare global {
  interface Window {
    __docrTitleCache?: Record<string, CacheEntry<string>>;
  }
}

interface DocForTitleCache {
  googleDocId: string;
  title?: string;
  lastModifiedInDrive?: Date | string | null;
}

function getModifiedAt(doc: DocForTitleCache): string | null {
  if (!doc.lastModifiedInDrive) return null;
  return typeof doc.lastModifiedInDrive === "string"
    ? doc.lastModifiedInDrive
    : doc.lastModifiedInDrive.toISOString();
}

/**
 * Manages a localStorage cache of doc titles.
 *
 * Each page component includes an inline script that reads cached titles for
 * its doc IDs from localStorage into window.__docrTitleCache before React
 * hydrates. This hook reads from that global in useLayoutEffect (after
 * hydration, before the next paint), populates state, then removes the
 * body-hiding style (from layout.tsx) so the page appears with titles already
 * in place. Stale/missing titles are fetched from /api/docs/titles in the
 * background.
 *
 * Returns a map of googleDocId → title string.
 */
export function useCachedTitles(userId: string, docs: DocForTitleCache[]): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const fetchedForRef = useRef<Record<string, string | null>>({});
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const hasEvicted = useRef(false);

  // Global cache populated by inline script in page component (reads localStorage before React hydrates)
  const globalCache = typeof window !== "undefined" ? window.__docrTitleCache : undefined;

  // Evict stale cache entries once per page load
  useLayoutEffect(() => {
    if (!userId || hasEvicted.current) return;
    hasEvicted.current = true;
    evictStale(userId, NAMESPACE, EVICT_AGE_MS);
  }, [userId]);

  // Stable key that changes only when the doc list or modification times actually change
  const docsKey = useMemo(
    () => docs.map((d) => `${d.googleDocId}:${getModifiedAt(d) ?? ""}:${d.title ?? ""}`).join(","),
    [docs]
  );

  const fetchTitles = useCallback(async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        const res = await apiFetch("/api/docs/titles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ googleDocIds: batch }),
        });
        if (!res.ok) continue;
        const freshTitles: Record<string, string> = await res.json();
        if (Object.keys(freshTitles).length === 0) continue;

        setTitles((prev) => ({ ...prev, ...freshTitles }));

        // Update cache
        const currentDocs = docsRef.current;
        const cacheUpdates: Record<string, { value: string; syncedAt: string }> = {};
        for (const [googleDocId, title] of Object.entries(freshTitles)) {
          const doc = currentDocs.find((d) => d.googleDocId === googleDocId);
          const syncedAt = doc ? getModifiedAt(doc) ?? new Date().toISOString() : new Date().toISOString();
          cacheUpdates[googleDocId] = { value: title, syncedAt };
        }
        setCachedBatch(userId, NAMESPACE, cacheUpdates);
      } catch {
        // Best-effort
      }
    }
  }, [userId]);

  // After hydration: update cache entries from server data, touch fresh entries, fetch stale ones
  useLayoutEffect(() => {
    if (!userId || docs.length === 0) return;

    // Use pre-parsed global cache if available, otherwise read from localStorage
    const googleDocIds = docs.map((d) => d.googleDocId);
    const cached = globalCache
      ? Object.fromEntries(googleDocIds.filter((id) => globalCache[id]).map((id) => [id, globalCache[id]]))
      : getCachedBatch<string>(userId, NAMESPACE, googleDocIds);

    const titleMap: Record<string, string> = {};
    const staleIds: string[] = [];

    for (const doc of docs) {
      const modifiedAt = getModifiedAt(doc);
      const entry = cached[doc.googleDocId];
      if (entry) {
        titleMap[doc.googleDocId] = entry.value;
        if (modifiedAt && entry.syncedAt === modifiedAt) {
          touchCached(userId, NAMESPACE, doc.googleDocId);
          continue; // cache is fresh
        }
      }
      // Cache miss or stale
      const prevFetchedFor = fetchedForRef.current[doc.googleDocId];
      if (prevFetchedFor !== modifiedAt) {
        staleIds.push(doc.googleDocId);
        fetchedForRef.current[doc.googleDocId] = modifiedAt;
      }
    }

    // Only update state if titles actually changed
    setTitles((prev) => {
      let changed = false;
      for (const [id, title] of Object.entries(titleMap)) {
        if (prev[id] !== title) { changed = true; break; }
      }
      if (!changed && Object.keys(titleMap).length === Object.keys(prev).length) return prev;
      return { ...prev, ...titleMap };
    });

    if (staleIds.length > 0) {
      fetchTitles(staleIds);
    }

    document.getElementById("hide-until-titles")?.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, docsKey, fetchTitles]);

  return titles;
}

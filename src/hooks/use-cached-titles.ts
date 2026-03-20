"use client";

import { useState, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { getCachedBatch, setCachedBatch, evictStale, touchCached } from "@/lib/browser-cache";
import { apiFetch } from "@/lib/api-fetch";

const NAMESPACE = "title";
const BATCH_SIZE = 100;
const EVICT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
 * On render, reads cached titles for all docs. For docs where the cache is
 * stale (syncedAt doesn't match lastModifiedInDrive) or missing, fresh
 * titles are fetched from Google Drive via /api/docs/titles.
 *
 * Returns a map of googleDocId → title string.
 */
export function useCachedTitles(userId: string, docs: DocForTitleCache[]): Record<string, string> {
  // Start empty to match server-rendered HTML, then populate from cache after mount
  const [titles, setTitles] = useState<Record<string, string>>({});
  const fetchedForRef = useRef<Record<string, string | null>>({});
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const hasEvicted = useRef(false);

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
        const res = await apiFetch(`/api/docs/titles?googleDocIds=${batch.join(",")}`);
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

  // useLayoutEffect runs before paint, so cached titles appear without a flash
  useLayoutEffect(() => {
    if (!userId || docs.length === 0) return;

    const googleDocIds = docs.map((d) => d.googleDocId);
    const cached = getCachedBatch<string>(userId, NAMESPACE, googleDocIds);

    const titleMap: Record<string, string> = {};
    const staleIds: string[] = [];
    const cacheUpdates: Record<string, { value: string; syncedAt: string }> = {};

    for (const doc of docs) {
      const modifiedAt = getModifiedAt(doc);

      if (doc.title) {
        // Server provided a title — use it and update cache
        titleMap[doc.googleDocId] = doc.title;
        if (modifiedAt) {
          cacheUpdates[doc.googleDocId] = { value: doc.title, syncedAt: modifiedAt };
        }
      } else {
        // No server title — check cache
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
    }

    if (Object.keys(cacheUpdates).length > 0) {
      setCachedBatch(userId, NAMESPACE, cacheUpdates);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, docsKey, fetchTitles]);

  return titles;
}

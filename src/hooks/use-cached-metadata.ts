"use client";

import { useState, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import type { CacheEntry } from "@/lib/browser-cache";
import { getCachedBatch, setCachedBatch, evictStale, touchCached } from "@/lib/browser-cache";
import { apiFetch } from "@/lib/api-fetch";
import type { DocMetadataEntry } from "@/app/api/docs/metadata/route";

const NAMESPACE = "meta";
const BATCH_SIZE = 100;
const EVICT_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

declare global {
  interface Window {
    __docrMetaCache?: Record<string, CacheEntry<DocMetadataEntry>>;
  }
}

interface DocForMetaCache {
  googleDocId: string;
  title?: string;
  lastModifiedInDrive?: Date | string | null;
}

function getModifiedAt(doc: DocForMetaCache): string | null {
  if (!doc.lastModifiedInDrive) return null;
  return typeof doc.lastModifiedInDrive === "string"
    ? doc.lastModifiedInDrive
    : doc.lastModifiedInDrive.toISOString();
}

export interface CachedMetadata {
  titles: Record<string, string>;
  owners: Record<string, string>;
}

/**
 * Manages a localStorage cache of doc metadata (titles and owners).
 *
 * Each page component includes an inline script that reads cached metadata for
 * its doc IDs from localStorage into window.__docrMetaCache before React
 * hydrates. This hook reads from that global in useLayoutEffect (after
 * hydration, before the next paint), populates state, then removes the
 * body-hiding style (from layout.tsx) so the page appears with titles already
 * in place. Stale/missing entries are fetched from /api/docs/metadata in the
 * background.
 *
 * Returns maps of googleDocId → title and googleDocId → owner.
 */
export function useCachedMetadata(userId: string, docs: DocForMetaCache[]): CachedMetadata {
  const [metadata, setMetadata] = useState<Record<string, DocMetadataEntry>>({});
  const fetchedForRef = useRef<Record<string, string | null>>({});
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const hasEvicted = useRef(false);

  // Global cache populated by inline script in page component (reads localStorage before React hydrates)
  const globalCache = typeof window !== "undefined" ? window.__docrMetaCache : undefined;

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

  const fetchMetadata = useCallback(async (ids: string[]) => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        const res = await apiFetch("/api/docs/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ googleDocIds: batch }),
        });
        if (!res.ok) continue;
        const freshMetadata: Record<string, DocMetadataEntry> = await res.json();
        if (Object.keys(freshMetadata).length === 0) continue;

        setMetadata((prev) => ({ ...prev, ...freshMetadata }));

        // Update cache
        const currentDocs = docsRef.current;
        const cacheUpdates: Record<string, { value: DocMetadataEntry; syncedAt: string }> = {};
        for (const [googleDocId, entry] of Object.entries(freshMetadata)) {
          const doc = currentDocs.find((d) => d.googleDocId === googleDocId);
          const syncedAt = doc ? getModifiedAt(doc) ?? new Date().toISOString() : new Date().toISOString();
          cacheUpdates[googleDocId] = { value: entry, syncedAt };
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
      : getCachedBatch<DocMetadataEntry>(userId, NAMESPACE, googleDocIds);

    const metaMap: Record<string, DocMetadataEntry> = {};
    const staleIds: string[] = [];

    for (const doc of docs) {
      const modifiedAt = getModifiedAt(doc);
      const entry = cached[doc.googleDocId];
      if (entry) {
        metaMap[doc.googleDocId] = entry.value;
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

    // Only update state if metadata actually changed
    setMetadata((prev) => {
      let changed = false;
      for (const [id, entry] of Object.entries(metaMap)) {
        if (prev[id]?.title !== entry.title || prev[id]?.owner !== entry.owner) { changed = true; break; }
      }
      if (!changed && Object.keys(metaMap).length === Object.keys(prev).length) return prev;
      return { ...prev, ...metaMap };
    });

    if (staleIds.length > 0) {
      fetchMetadata(staleIds);
    }

    document.getElementById("hide-until-titles")?.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, docsKey, fetchMetadata]);

  // Derive separate title and owner maps for consumers
  return useMemo(() => {
    const titles: Record<string, string> = {};
    const owners: Record<string, string> = {};
    for (const [id, entry] of Object.entries(metadata)) {
      if (entry.title) titles[id] = entry.title;
      if (entry.owner) owners[id] = entry.owner;
    }
    return { titles, owners };
  }, [metadata]);
}

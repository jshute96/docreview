# Browser Local Storage Cache

Docreview uses the browser's `localStorage` API to cache data that the server intentionally doesn't send in initial page loads — primarily doc titles and (planned) comment text. This avoids storing user content on the server while still providing a responsive UI.

## Motivation

Google Docs titles and comment text are user content that we prefer not to store in our database. Instead, we fetch them from Google APIs on demand. But fetching on every page load causes a visible delay — the page renders with empty titles, then they pop in.

The localStorage cache solves this by storing previously-seen values on the user's own device. On page load, cached values appear instantly while fresh data loads in the background.

## Privacy Model

Storing data in `localStorage` rather than the server database is more privacy-preserving:
- Data stays on the user's device — we're not a custodian of it
- If our database is breached, user content (titles, comment text) isn't exposed
- Aligns with data minimization principles (GDPR, etc.)

`localStorage` is scoped to the origin (`scheme + domain + port`), so other sites cannot read the cache. Keys are namespaced per user to prevent leakage if multiple users share a browser profile.

## Cache Structure

### Key format

```
docr:{userId}:{namespace}:{id}
```

Examples:
```
docr:abc123:title:1BxiMVs0XRA5nFMdKvBdBZjgmUii5vT-Enh
docr:abc123:thread:AABx8Hjq5K  (planned)
```

### Value format

All values are JSON-encoded objects:
```json
{
  "value": "My Document Title",
  "syncedAt": "2026-03-15T10:30:00.000Z",
  "cachedAt": "2026-03-15T10:30:00.000Z"
}
```

The `syncedAt` timestamp is the doc's `lastModifiedInDrive` at the time the value was cached. This is Google Drive's own modification timestamp — it changes when the doc content or metadata (including title) changes, but not when comments change. If `syncedAt` matches what the server returns for a doc, the cached value is fresh and no fetch is needed.

We use `lastModifiedInDrive` rather than `commentsLastSyncedAt` because `commentsLastSyncedAt` updates on every refresh even if nothing changed, which would cause unnecessary title re-fetches. `lastModifiedInDrive` only changes when the document actually changed in Drive.

## Data Flow

### Doc Titles

```
Page load
  │
  ├─ Inline <style> in layout.tsx <head> hides body (visibility:hidden)
  ├─ Inline <script> in layout.tsx <head> sets 2s fallback to remove hiding style
  │
  ├─ Server returns docs WITHOUT titles (stripped via stripTitle())
  ├─ Inline <script> in page component reads only needed doc IDs
  │    from localStorage into window.__docrTitleCache
  │
  ├─ React hydrates → useLayoutEffect fires (before next paint)
  │    ├─ Read cached titles from window.__docrTitleCache (or localStorage fallback)
  │    ├─ For each doc:
  │    │    ├─ Cache fresh (syncedAt matches)? → use cached value, touch cachedAt
  │    │    └─ Cache stale or missing? → add to stale list
  │    ├─ Set title state
  │    └─ Remove body-hiding <style> → page appears with titles in place
  │
  └─ Async: fetch fresh titles for stale docs
       POST /api/docs/titles { googleDocIds: [id1, id2, ...] }
       └─ Update state + cache when response arrives
```

The fallback timeout ensures the page is never permanently hidden if the hook doesn't run (e.g. JS error).

### Staleness Detection

A cached title is considered **fresh** when its `syncedAt` timestamp matches the doc's `lastModifiedInDrive` from the server. This timestamp only changes when the document is actually modified in Drive (including renames), so a match means the title hasn't changed.

A cached title is **stale** when:
- The doc's `lastModifiedInDrive` is newer than the cached `syncedAt`
- The doc has never been cached (first visit)

Stale titles are fetched from Google Drive via `/api/docs/titles` and the cache is updated.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/browser-cache.ts` | Generic localStorage cache utility — get/set/batch/evict |
| `src/hooks/use-cached-titles.ts` | React hook managing title cache lifecycle |
| `src/app/api/docs/titles/route.ts` | API endpoint fetching titles from Google Drive |

### browser-cache.ts

Provides generic cache operations, not title-specific:
- `getCached(userId, namespace, id)` / `setCached(...)` — single entry read/write
- `getCachedBatch(...)` / `setCachedBatch(...)` — multi-entry operations
- `touchCached(userId, namespace, id)` — refresh `cachedAt` on a cache hit (at most once per 24h, to reduce write churn)
- `evictStale(userId, namespace, cutoffMs)` — remove entries older than a cutoff

All operations are wrapped in try/catch — cache failures are silent since the cache is best-effort.

### use-cached-titles.ts

React hook used by `DocTable` and `DocDetail`. Handles:
- Cache read from `window.__docrTitleCache` (pre-populated by page-level inline script) in `useLayoutEffect`
- Removing the body-hiding `<style>` element after populating title state
- Staleness detection and cache maintenance
- Async fetch for stale/missing titles via `/api/docs/titles`
- Deduplication — tracks which docs have already been fetched to avoid redundant API calls
- Batching — splits large requests into chunks of 100

The hook depends on a stable `docsKey` string (derived from doc IDs + modification timestamps) rather than the `docs` array reference, preventing infinite re-render loops.

### /api/docs/titles

`POST /api/docs/titles { googleDocIds: [id1, id2, ...] }`

Fetches current titles directly from Google Drive (`files.get` with `fields: "id, name"`). Returns `{ [googleDocId]: title }`. For docs that fail to fetch from Drive (e.g. inaccessible), falls back to the title stored in the database. Capped at 100 IDs per request, with 10-way parallelism.

## Capacity

`localStorage` provides 5-10 MB per origin (varies by browser). A title entry is roughly 100-200 bytes. At 200 bytes, the cache can hold ~25,000-50,000 titles before hitting the limit — well beyond any realistic usage.

The `useCachedTitles` hook calls `evictStale()` once per page load to remove entries not accessed in the last 30 days, preventing unbounded cache growth. Eviction is based on `cachedAt`, not `syncedAt`, so docs that haven't changed in Drive for a long time aren't incorrectly evicted. On cache hits (fresh entry used without re-fetching), `cachedAt` is refreshed via `touchCached()` — but at most once per 24 hours to avoid write churn. This keeps actively-viewed docs alive in the cache regardless of how old their `lastModifiedInDrive` timestamp is.

## Future: Comment Text Caching

The same infrastructure is designed to cache comment text and replies, which are currently fetched live from Google APIs on every visit to a doc's comments page. The pattern is identical:

```
docr:{userId}:thread:{googleCommentId}
```

The `browser-cache.ts` utilities are namespace-agnostic, so adding comment caching requires only a new hook (similar to `useCachedTitles`) and wiring it into the comment display components.

## Current State: Titles Stripped from API Responses

Server responses no longer include doc titles — `stripTitle()` in `doc-queries.ts` clears the `title` field before sending docs to the client. This applies to all doc-returning endpoints (`GET /api/docs`, `GET /api/docs/[docId]`, `PATCH /api/docs/[docId]`, `PATCH /api/docs/bulk-update`, `POST /api/docs/add`, `POST /api/docs/[docId]/re-add`) and server components (docs listing page, comments page).

Titles are still stored in the database (used during sync and for inaccessible docs), but the client relies entirely on the localStorage cache and `/api/docs/titles` for display. On first visit with an empty cache, titles show "Unknown title" briefly until fetched from Google Drive.

The `filterDocs` and `sortDocs` functions in `doc-filters.ts` accept an optional `titles` map for filtering/sorting by title when `doc.title` is empty.

## Future: Removing Titles from the Database

The title column can eventually be removed from the database entirely, with one exception: inaccessible docs (see below).

### Inaccessible docs

Docs with `accessState` of `DENIED`, `NOT_FOUND`, or `TRASHED` cannot have their titles fetched from Google Drive. Today, these docs retain a user-chosen or previously-fetched title in the database. When titles are removed from the DB, we'll need to keep storing titles for inaccessible docs specifically — either by retaining a `title` column only for these cases, or by treating the localStorage cache as the source of truth (with the risk that clearing the cache loses the title permanently).

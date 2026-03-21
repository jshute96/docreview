# Browser Local Storage Cache

Docreview uses the browser's `localStorage` API to cache data that the server intentionally doesn't send in initial page loads — doc titles, owners, and (planned) comment text. This avoids storing user content on the server while still providing a responsive UI.

## Motivation

Google Docs titles, owners, and comment text are user content that we prefer not to store in our database. Instead, we fetch them from Google APIs on demand. But fetching on every page load causes a visible delay — the page renders with empty titles, then they pop in.

The localStorage cache solves this by storing previously-seen values on the user's own device. On page load, cached values appear instantly while fresh data loads in the background.

## Privacy Model

Storing data in `localStorage` rather than the server database is more privacy-preserving:
- Data stays on the user's device — we're not a custodian of it
- If our database is breached, user content (titles, owners, comment text) isn't exposed
- Aligns with data minimization principles (GDPR, etc.)

`localStorage` is scoped to the origin (`scheme + domain + port`), so other sites cannot read the cache. Keys are namespaced per user to prevent leakage if multiple users share a browser profile.

## Cache Structure

### Key format

```
docr:{userId}:{namespace}:{id}
```

Examples:
```
docr:abc123:meta:1BxiMVs0XRA5nFMdKvBdBZjgmUii5vT-Enh
docr:abc123:thread:AABx8Hjq5K  (planned)
```

### Value format

All values are JSON-encoded objects:
```json
{
  "value": { "title": "My Document Title", "owner": "Jane Doe" },
  "syncedAt": "2026-03-15T10:30:00.000Z",
  "cachedAt": "2026-03-15T10:30:00.000Z"
}
```

The `syncedAt` timestamp is the doc's `lastModifiedInDrive` at the time the value was cached. This is Google Drive's own modification timestamp — it changes when the doc content or metadata (including title) changes, but not when comments change. If `syncedAt` matches what the server returns for a doc, the cached value is fresh and no fetch is needed.

We use `lastModifiedInDrive` rather than `commentsLastSyncedAt` because `commentsLastSyncedAt` updates on every refresh even if nothing changed, which would cause unnecessary re-fetches. `lastModifiedInDrive` only changes when the document actually changed in Drive.

## Data Flow

### Doc Metadata (Titles and Owners)

```
Page load
  |
  +- Inline <style> in page component hides body (visibility:hidden)
  +- Inline <script> in page component sets 2s fallback to remove hiding style
  |    (only docs/page.tsx and comments/[docId]/page.tsx include these)
  |
  +- Server returns docs WITHOUT titles or owners (stripped via stripServerOnly())
  +- Inline <script> in page component reads only needed doc IDs
  |    from localStorage into window.__docrMetaCache
  |
  +- React hydrates -> useLayoutEffect fires (before next paint)
  |    +- Read cached metadata from window.__docrMetaCache (or localStorage fallback)
  |    +- For each doc:
  |    |    +- Cache fresh (syncedAt matches)? -> use cached value, touch cachedAt
  |    |    +- Cache stale or missing? -> add to stale list
  |    +- Set metadata state (titles + owners)
  |    +- Remove body-hiding <style> -> page appears with titles in place
  |
  +- Async: fetch fresh metadata for stale docs
       POST /api/docs/metadata { googleDocIds: [id1, id2, ...] }
       +- Update state + cache when response arrives
```

The fallback timeout ensures the page is never permanently hidden if the hook doesn't run (e.g. JS error).

### Staleness Detection

A cached entry is considered **fresh** when its `syncedAt` timestamp matches the doc's `lastModifiedInDrive` from the server. This timestamp only changes when the document is actually modified in Drive (including renames), so a match means the metadata hasn't changed.

A cached entry is **stale** when:
- The doc's `lastModifiedInDrive` is newer than the cached `syncedAt`
- The doc has never been cached (first visit)

Stale entries are fetched from Google Drive via `/api/docs/metadata` and the cache is updated.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/browser-cache.ts` | Generic localStorage cache utility — get/set/batch/evict/clear |
| `src/hooks/use-cached-metadata.ts` | React hook managing metadata cache lifecycle |
| `src/app/api/docs/metadata/route.ts` | API endpoint fetching titles and owners from Google Drive |

### browser-cache.ts

Provides generic cache operations, not metadata-specific:
- `getCached(userId, namespace, id)` / `setCached(...)` — single entry read/write
- `getCachedBatch(...)` / `setCachedBatch(...)` — multi-entry operations
- `touchCached(userId, namespace, id)` — refresh `cachedAt` on a cache hit (at most once per 24h, to reduce write churn)
- `evictStale(userId, namespace, cutoffMs)` — remove entries older than a cutoff
- `clearAll()` — remove all `docr:` entries from localStorage (not scoped by userId, but in practice only one user per browser); used by the "Clear cache" menu item

All operations are wrapped in try/catch — cache failures are silent since the cache is best-effort.

### use-cached-metadata.ts

React hook used by `DocTable` and `DocDetail`. Returns `{ titles, owners }` maps. Handles:
- Cache read from `window.__docrMetaCache` (pre-populated by page-level inline script) in `useLayoutEffect`
- Removing the body-hiding `<style>` element after populating state
- Staleness detection and cache maintenance
- Async fetch for stale/missing entries via `/api/docs/metadata`
- Deduplication — tracks which docs have already been fetched to avoid redundant API calls
- Batching — splits large requests into chunks of 100

The hook depends on a stable `docsKey` string (derived from doc IDs + modification timestamps) rather than the `docs` array reference, preventing infinite re-render loops.

### /api/docs/metadata

`POST /api/docs/metadata { googleDocIds: [id1, id2, ...] }`

Fetches current titles and owners from Google Drive (`files.get` with `fields: "id, name, owners(displayName)"`). Returns `{ [googleDocId]: { title, owner } }`. For docs that fail to fetch from Drive (e.g. inaccessible), falls back to the title stored in the database (owner will be null). Capped at 100 IDs per request, with 10-way parallelism.

## Capacity

`localStorage` provides 5-10 MB per origin (varies by browser). A metadata entry (title + owner) is roughly 150-300 bytes. At 300 bytes, the cache can hold ~17,000-33,000 entries before hitting the limit — well beyond any realistic usage.

The `useCachedMetadata` hook calls `evictStale()` once per page load to remove entries not accessed in the last 30 days, preventing unbounded cache growth. Eviction is based on `cachedAt`, not `syncedAt`, so docs that haven't changed in Drive for a long time aren't incorrectly evicted. On cache hits (fresh entry used without re-fetching), `cachedAt` is refreshed via `touchCached()` — but at most once per 24 hours to avoid write churn. This keeps actively-viewed docs alive in the cache regardless of how old their `lastModifiedInDrive` timestamp is. Users can also manually clear all cached data via the "Clear cache" item in the main menu.

## Future: Comment Text Caching

The same infrastructure is designed to cache comment text and replies, which are currently fetched live from Google APIs on every visit to a doc's comments page. The pattern is identical:

```
docr:{userId}:thread:{googleCommentId}
```

The `browser-cache.ts` utilities are namespace-agnostic, so adding comment caching requires only a new hook (similar to `useCachedMetadata`) and wiring it into the comment display components.

## Design: Unified Title/Owner Flow

The client always gets titles and owners through a single path — the localStorage cache backed by `/api/docs/metadata` — regardless of whether a doc is accessible in Drive or not. Doc-returning API endpoints (`GET /api/docs`, `PATCH /api/docs/[docId]`, etc.) strip titles via `stripServerOnly()` in `doc-queries.ts` so the client never mixes sources. Owner is not stored in the database at all (the column was dropped).

The `/api/docs/metadata` endpoint resolves the data from different sources depending on accessibility:
- **Accessible docs**: fetches title and owner from the Google Drive API
- **Inaccessible docs** (DENIED/NOT_FOUND): falls back to the title stored in the database (owner will be null)

This means the client doesn't need to know or care where the title came from — it always looks the same.

### How titles get into the database

For accessible docs, DB write paths (upsert in `refresh.ts`, `docs/route.ts` load mode, `add/route.ts`) write `title: ""`. The title only exists in Drive and the browser cache.

Inaccessible docs can't have their titles fetched from Drive, so they store a fallback title in the DB:
- Docs added manually with a custom title (`add/route.ts` permission-denied path) store the user-provided title
- Docs discovered via Gmail notifications (`insertInaccessibleDocs` in `refresh.ts`) store the title parsed from the email

When an inaccessible doc later gains access, the next refresh writes `title: ""` via the upsert update path, and the client fetches the real title and owner from Drive (the changed `lastModifiedInDrive` triggers a cache refresh).

### Client display

On first visit with an empty cache, titles show "Unknown title" briefly until fetched from Google Drive. Owners show "—" until fetched.

The `filterDocs` and `sortDocs` functions in `doc-filters.ts` accept an optional `titles` map for filtering/sorting by title when `doc.title` is empty.

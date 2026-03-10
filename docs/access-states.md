# Access States

Each doc has an `accessState` enum column with four possible values:

| State | Meaning |
|-------|---------|
| `OK` | We can access the doc normally |
| `TRASHED` | The doc is in Drive's trash (may be restored) |
| `NOT_FOUND` | The doc is permanently deleted or was never found |
| `DENIED` | The doc exists (or may exist) but we don't have permission |

Default is `OK`.

## State Transitions

Access state is determined solely by **file-level** access (`files.get` and
`changes.list`). Comment-level permissions (e.g., view-only docs where
`comments.list` returns 403 but `files.get` succeeds) are tracked separately
and do not affect access state.

```
         ┌──────────────┐
    ┌───>│      OK      │<───┐
    │    └──┬───┬───┬───┘    │
    │       │   │   │        │
    │       │   │   └──> DENIED
    │       │   │
    │       │   └──────> NOT_FOUND
    │       v                ^
    │    TRASHED ────────────┘
    │       │
    └───────┘  (restored)
```

Note: there is no transition from `DENIED` to `NOT_FOUND`. Google's API
returns 404 for both "doesn't exist" and "no permission" — so a 404 on a
doc already in `DENIED` state is ambiguous and we keep it as `DENIED`. The
only path to `NOT_FOUND` is from `OK` (via 404 or changes.list removed) or
from `TRASHED` (via 404, meaning permanently deleted from trash).

### From OK
- **files.get returns 404** → `NOT_FOUND`
- **files.get returns 403** → `DENIED`
- **files.get returns trashed: true** → `TRASHED`
- **Drive changes.list reports removed** → `NOT_FOUND`
- **Drive changes.list reports trashed** → `TRASHED`

### From TRASHED
- **Successful metadata fetch (not trashed)** → `OK` (doc was restored)
- **files.get returns 404** → `NOT_FOUND` (permanently deleted from trash)
- **files.get returns 403** → `DENIED` (permission revoked while trashed)

### From NOT_FOUND
- **Successful metadata fetch** → `OK` (was actually a permission issue, now resolved)
- Stays `NOT_FOUND` on continued 404

### From DENIED
- **Successful metadata fetch** → `OK` (access granted)
- Stays `DENIED` on 403 or 404 (can't distinguish deletion from permission denial)

## How Refresh Handles Each State

### Bulk refresh (executeRefresh)
- Discovers docs via Drive changes.list and Gmail scan
- Only processes docs that appear in those discovery sources
- The stale-comments catch-up query only includes `OK` docs
  (comment sync would fail on non-OK docs anyway)
- For docs not returned by `fetchDocsByIds`, `markMissingAsDeletedOrDenied`
  does a verification `files.get`:
  - 404 from `OK` or `TRASHED` → `NOT_FOUND`
  - 404 from `DENIED` → stays `DENIED`
  - 403 → `DENIED`
- After successful metadata fetch, `upsertDocsAndSyncComments` sets state to `OK`

### Full refresh (executeFullRefresh)
- Refreshes **all** docs regardless of current state, so non-OK docs
  get a chance to recover (e.g., access granted, restored from trash)
- Non-OK docs that fail `fetchDocsByIds` (404/403) never reach
  `upsertDocsAndSyncComments` — they go through
  `markMissingAsDeletedOrDenied` instead, which applies the same
  transition rules as single-doc refresh

### Selected refresh (refreshSelectedDocs)
- Refreshes the specified docs regardless of current state
- Same logic as full refresh

### Single doc refresh ([docId]/refresh)
- Always attempts refresh regardless of current state
- files.get result:
  - 404 from `OK` or `TRASHED` → `NOT_FOUND`; from `DENIED` → stays `DENIED`
  - 403 → `DENIED`
  - trashed: true → `TRASHED`
  - success → proceeds to upsert (which sets `OK`) and comment sync

## How Add Handles Each State

### New doc (not in database)
- **files.get succeeds**: Creates doc with `OK`, syncs comments
- **files.get fails (any non-auth error)**: Creates doc with `DENIED`,
  skips comment sync. User can set a custom title via the add form.

### Existing doc in OK state
- Updates labels, notes, status (existing behavior — not a re-add)

### Existing doc in non-OK state (NOT_FOUND, TRASHED, DENIED)
- The validate route treats these as non-existing (allows re-add)
- The add route uses upsert to revive the doc:
  - If files.get succeeds: sets `OK` with fresh metadata
  - If files.get fails: sets `DENIED` with user-provided or default title

## Display

### /docs page (doc list)

| State | Title style | Subline |
|-------|-------------|---------|
| `OK` | Normal | Notes only |
| `TRASHED` | Strikethrough, gray | "(In trash)" in red, then notes |
| `NOT_FOUND` | Strikethrough, gray | "(Deleted)" in red, then notes |
| `DENIED` | Strikethrough, gray | "(No access)" in red, then notes |

### /comments/[docId] page

| State | Banner |
|-------|--------|
| `OK` | None |
| `TRASHED` | Red banner: "This document is in the trash." |
| `NOT_FOUND` | Red banner: "This document was deleted from Google Drive or is no longer accessible." |
| `DENIED` | Red banner: "Permission denied" |

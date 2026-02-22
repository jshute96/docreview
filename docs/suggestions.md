# Suggestions

## What Suggestions Are

Google Docs has two distinct annotation features:

- **Comments** — threaded discussions attached to selected text. Created from the Insert menu
  or by selecting text and clicking the comment icon.
- **Suggestions** — tracked changes where a collaborator proposes an edit (insertion,
  deletion, or replacement). Created by switching the doc to "Suggesting" mode and typing.

Docreview tracks both. This document covers how suggestions work and how they are synced.

---

## Two APIs, Two ID Systems

Suggestions are visible in two Google APIs, but each uses a completely different ID format
and neither can be directly correlated to the other.

### Docs API (`documents.get`)

`documents.get` with `suggestionsViewMode: "SUGGESTIONS_INLINE"` walks the document body and
returns all **pending** suggestions inline. Each text run has `suggestedInsertionIds` and
`suggestedDeletionIds` arrays. These IDs use the format `suggest.xxxxx`.

This is the **only reliable way to enumerate all pending suggestions** in a document.

### Drive API (`comments.list`)

`comments.list` exposes some suggestions as Drive comment threads. These can be detected by
their `anchor` field:

- **Older format** (most common): a plain string like `kix.ms71xr5lj8t`
- **Newer format**: JSON like `{"r":"head","a":[{"ct":"sgst","si":"suggest.xxxxx"}]}`
  (the `si` field contains the Docs API suggestion ID)

Drive comment IDs for suggestions (and regular comments) use the format `AAAB0xxxxx`.

### The Cross-Reference Problem

There is no documented API that maps `suggest.xxx` (Docs API) ↔ `kix.xxx` (Drive anchor) ↔
`AAAB0xxx` (Drive comment ID). The three are different internal representations with no
queryable relationship. This has significant downstream effects — see Limitations below.

---

## How Drive API Handles Suggestions

**Drive API does not reliably return all pending suggestions** via `comments.list`. In
testing, a document with 4 pending suggestions (confirmed by Docs API) returned only 1
suggestion as a Drive comment. The others were invisible to `comments.list`.

The exact rule for which suggestions become Drive comment threads is not documented. Empirical
observation: already-resolved (accepted/rejected) suggestions tend to appear as Drive comments
with `resolved: true`, while currently-pending suggestions may or may not be surfaced.

**`startModifiedTime` filter:** when `comments.list` is called with a `startModifiedTime`
parameter (incremental sync), suggestion comments are excluded unless they were recently
modified. This was the cause of an earlier bug where suggestions disappeared after the first
full sync: the second refresh used the since-filter and found nothing, stranding the records.
The per-doc Refresh now always does a **full scan** (no `startModifiedTime`) to avoid this.

---

## Current Sync Approach (Dual Sync)

Every Refresh on the doc detail page runs two independent syncs:

### 1. Drive API Sync

`fetchComments` calls `comments.list` without a time filter. For each comment:

- Regular comments (no anchor, or non-kix anchor) → stored with their Drive comment ID
  (`AAAB0xxx`), including `driveCreatedAt`, `driveModifiedAt`, `replyCount`, `isMine`,
  `iParticipated`, `iResolvedIt`.
- Suggestion comments (`kix.xxx` or JSON anchor with `ct: "sgst"`) → stored with their Drive
  comment ID (`AAAB0xxx`), `type: "SUGGESTION"`.
  - For JSON-format anchors: `docsSuggestionId` is extracted from the `si` field, and the
    Docs API type map is used to set `suggestionType` (INSERT / DELETE / EDIT).
  - For `kix.xxx`-format anchors: `suggestionType` is left null (no Docs ID available to
    cross-reference).

### 2. Docs API Sync

`fetchSuggestions` calls `documents.get` with `SUGGESTIONS_INLINE` and walks the body to
find all pending suggestion IDs (`suggest.xxx`). Each is upserted into the Comment table:

- **Create** (new): `type: "SUGGESTION"`, `suggestionType` set, `resolved: false`,
  `status: "ACTIVE"`. No timestamps — Docs API doesn't provide them.
- **Update** (existing): only `suggestionType` is updated (preserves user-set status).

After upserting, any `suggest.xxx` records that are **no longer in the Docs API response**
are marked `resolved: true` (the suggestion was accepted or rejected). AAAB0xxx records
are skipped here — their resolved state is handled by the Drive sync.

### Coexistence of AAAB0xxx and suggest.xxx Records

Because the two syncs run independently and can't cross-reference IDs, a suggestion that
happens to be surfaced by *both* APIs will have **two separate DB records**: one with an
AAAB0xxx ID and one with a `suggest.xxx` ID. In practice this is uncommon — Drive-surfaced
suggestions tend to already be resolved (archived, hidden from the default active view),
so the visible suggestion count is usually correct.

---

## Disco URLs (Jumping to a Suggestion)

Google Docs supports `?disco={id}` to open the doc and jump directly to a comment or
suggestion thread. The ID must be the Drive comment ID (`AAAB0xxx`).

- **`?disco=AAAB0xxx`** — works. Opens the doc and highlights the suggestion thread.
- **`?disco=suggest.xxx`** — does not work for navigation. The doc opens but the URL
  parameter is ignored; no thread is highlighted.

Clicking a suggestion row always opens the doc using `window.open` with a named window
(`"docreview-comment-window"`) so repeated clicks reuse the same tab.

---

## Limitations

### Suggestions without Drive comment IDs

For suggestions stored with `suggest.xxx` IDs (the majority, coming from Docs API sync),
clicking opens the document but **does not jump to the specific suggestion**. There is no
working disco URL for them because the `AAAB0xxx` Drive comment ID is not available.

### No timestamps for Docs-API suggestions

The Docs API does not return `createdTime` or `modifiedTime` for suggestions. These fields
are `null` for `suggest.xxx` records, showing "—" in the UI. To get suggestion timestamps,
the Drive Activity API would be required (a separate scope and API not currently used).

### No isMine / iParticipated for Docs-API suggestions

Similarly, authorship and reply participation come from Drive API comment data. Records
created by the Docs sync have `isMine: false` and `iParticipated: false` by default. The
"My threads" and "My comments" filters therefore have no effect on Docs-sourced suggestions.

### suggestionType null for kix.xxx-anchor suggestions

For suggestions surfaced by Drive API with a plain `kix.xxx` anchor (no JSON, no Docs ID
embedded), there is no way to determine whether the edit is an INSERT, DELETE, or EDIT.
`suggestionType` is stored as null. In practice these tend to be resolved/archived so they
rarely appear in the active view.

### Suggestion text content

Suggestion text (the inserted and deleted strings) is fetched live from `documents.get` on
the comments API call, keyed by `suggest.xxx`. It displays correctly for Docs-sourced
suggestions. For AAAB0xxx-keyed records, content is available only if the Drive comment had
a JSON-format anchor with the `si` field pointing to a matching Docs suggestion ID; for the
more common `kix.xxx` anchor format, no content is available and the content row is hidden.

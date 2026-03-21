# Suggestions

## What Suggestions Are

Google Docs has two distinct annotation features:

- **Comments** — threaded discussions attached to selected text. Created from the Insert menu
  or by selecting text and clicking the comment icon.
- **Suggestions** — tracked changes where a collaborator proposes an edit (insertion,
  deletion, or replacement). Created by switching the doc to "Suggesting" mode and typing.

Docreview tracks both. This document covers how suggestions work and how they are synced.

---

## Why Drive API Is Not Used for Suggestions

`comments.list` (Drive API) exposes some suggestions as comment threads, but it is
unreliable: in testing, a document with 4 pending suggestions (confirmed by Docs API)
returned only 1 via `comments.list`. The others were invisible. The exact rule is
undocumented.

Additionally, the `anchor` field that Drive uses to mark suggestion threads comes in two
formats:

- **JSON format**: `{"r":"head","a":[{"ct":"sgst","si":"suggest.xxxxx"}]}`
- **Plain string**: `kix.ms71xr5lj8t`

The plain `kix.xxx` format cannot be used to identify suggestions because regular comments
in older Google Docs use the same anchor style. The JSON format is unambiguous but only
appears in newer docs, and Drive still doesn't surface all suggestions that way.

Because of these reliability problems, **Docreview does not use Drive API to detect or
store suggestions**. All suggestion data comes from the Docs API.

---

## Sync Approach (Docs API)

Every Refresh calls `fetchSuggestions`, which calls `documents.get` with
`suggestionsViewMode: "SUGGESTIONS_INLINE"` and walks the document body to collect all
pending suggestion IDs (`suggest.xxx`). Each is upserted into the Comment table:

- **Create** (new): `type: "SUGGESTION"`, `googleSuggestionId` set to the `suggest.xxx` ID,
  `suggestionType` set, `resolved: false`, `status: "INBOX"`. No timestamps — Docs API
  doesn't provide them.
- **Update** (existing): only `suggestionType` is updated (preserves user-set status).

After upserting, any `suggest.xxx` records **no longer in the Docs API response** are
marked `resolved: true` (the suggestion was accepted or rejected). This runs even when the
Docs API returns zero suggestions, so the last remaining suggestion is correctly resolved.

---

## ID Split: googleSuggestionId vs googleCommentId

Suggestions are stored with two separate ID fields:

- **`googleSuggestionId`** — the Docs API ID (`suggest.xxx`), always set for suggestions.
  Used for Docs API lookups and as the key for suggestion content maps.
- **`googleCommentId`** — the Drive comment ID (`AAAB0xxx`), set when available (e.g.,
  from Gmail notification merge). Used for `?disco=` deep links.

Comments use only `googleCommentId` (Drive comment ID). Both fields have unique indexes
with `docId`. PostgreSQL treats NULLs as distinct in unique constraints, so NULL values
in either field don't conflict.

## Disco URLs (Jumping to a Suggestion)

Google Docs supports `?disco={id}` to open the doc and jump directly to a comment or
suggestion thread. The ID must be a Drive comment ID (`AAAB0xxx`).

When a suggestion has `googleCommentId` set (from Gmail notification merge), the Open
button uses `?disco=` to jump directly to it. When only `googleSuggestionId` is available,
the doc opens without `?disco=` — the user must scroll to find the suggestion.

Clicking a row always opens the doc using `window.open` with a named window
(`"docreview-comment-window"`) so repeated clicks reuse the same tab.

---

## Limitations

### Limited navigation to specific suggestion

Suggestions only get `?disco=` navigation when `googleCommentId` is set (from Gmail
notification merge). Without it, clicking a suggestion row opens the doc without scrolling
to the suggestion.

### Approximate created timestamp

The Docs API does not return `createdTime` or `modifiedTime` for suggestions. When a
suggestion is first synced, `driveCreatedAt` is set to the doc's `lastModifiedInDrive`
timestamp (falling back to the current time if that is null). This is a rough
approximation — the suggestion may have been created before or after that timestamp.
`driveModifiedAt` remains `null` and shows "—" in the UI.

### No isThreadAuthor / isReplyAuthor

Authorship and reply participation come from Drive API comment data. Suggestion records
have `isThreadAuthor: false` and `isReplyAuthor: false` by default. The "Mine" and "Replied"
filters have no effect on suggestions.

### Suggestion text content

Suggestion text (inserted and deleted strings) is fetched on page load via `fetchDocContent`,
which makes a single `documents.get` call with `SUGGESTIONS_INLINE` to extract both suggestion
content and document body text. Results are keyed by `suggest.xxx` (`googleSuggestionId`) and
display correctly for all suggestion records.

### Permissions and View-Only Access

If a user has "Viewer" access to a document but lacks permission to view suggestions or comments, the Docs API call with `suggestionsViewMode: "SUGGESTIONS_INLINE"` will fail with a `403 Forbidden` error indicating `permission to access the document suggestions`. 

Docreview handles this gracefully:
- In `fetchDocContent`, it logs a warning and retries the fetch *without* requesting suggestions so the document text can still be displayed.
- In `syncComments`, the suggestion fetch is skipped, and a warning is logged. Existing suggestions in the database are left untouched (not incorrectly marked as resolved).
- In `fetchAllThreads` (which powers the thread view for the UI), 403 errors are caught and logged as warnings, returning empty lists so the page can continue functioning and load the document text.

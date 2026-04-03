# Suggestions

## What Suggestions Are

Google Docs has two distinct annotation features:

- **Comments** — threaded discussions attached to selected text. Created from the Insert menu
  or by selecting text and clicking the comment icon.
- **Suggestions** — tracked changes where a collaborator proposes an edit (insertion,
  deletion, or replacement). Created by switching the doc to "Suggesting" mode and typing.
  Suggestions can also be non-text changes like formatting (bold, italic, font), link
  additions, or spacing changes.

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
`suggestionsViewMode: "SUGGESTIONS_INLINE"` and `includeTabsContent: true`, then walks
the body content of every tab (including nested child tabs) to collect all pending
suggestion IDs (`suggest.xxx`). Each is upserted into the Comment table:

- **Create** (new): `type: "SUGGESTION"`, `googleSuggestionId` set to the `suggest.xxx` ID,
  `suggestionType` set, `resolved: false`, `status: "INBOX"` if `doc.role === "AUTHOR"`,
  otherwise `"ARCHIVED"`. `driveCreatedAt` and `driveModifiedAt` are set to
  `doc.lastModifiedInDrive` (Docs API doesn't provide per-suggestion timestamps).
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

## Cross-Source Merge (Docs API + Gmail)

Suggestion data comes from two sources with different strengths. A content hash
(`suggestionContentHash`) enables matching across them.

**Text Normalization:** To ensure the Docs API and Gmail hashes match, both strings are
normalized before hashing: trimmed, converted to lowercase, and all whitespace sequences
(including newlines) replaced by a single space.

**Assembly Logic:** When collecting suggestion fragments from the Docs API, Docreview
preserves structural newlines between fragments (e.g., when a suggestion spans multiple
paragraphs). This ensures that normalized whitespace exists between these fragments in the
final hash. Only the final trailing newline of the fully concatenated suggestion is
stripped before storage.


### Column sources and merge rules

| Column | Docs API (Drive sync) | Gmail notification | Merge rule |
|--------|----------------------|-------------------|------------|
| `googleSuggestionId` | `suggest.xxx` | — | Drive only |
| `googleCommentId` | — | `discussionId` (AAA*) | Gmail only |
| `suggestionContentHash` | computed from text | computed from text | Either (should match) |
| `type` | SUGGESTION | SUGGESTION | Either |
| `suggestionType` | INSERT/DELETE/EDIT/OTHER | mappable from Add/Delete/Replace/Other | Either |
| `resolved` | lifecycle (false→true) | — | Drive authoritative |
| `driveCreatedAt` | `doc.lastModifiedInDrive` (approx) | `time` (minute precision) | Gmail preferred (more accurate) |
| `driveModifiedAt` | `doc.lastModifiedInDrive` (approx) | `time` (minute precision) | Gmail preferred; extension updates with last reply timestamp |
| `replyCount` | 0 (always) | `replies.length` | Gmail (Drive has no data) |
| `isThreadAuthor` | false | — | false |
| `isReplyAuthor` | false | — | false |
| `mentionedMe` | false | — | false |

**Extension source:** When extension suggestions are merged into the DB, the merge also
populates `isThreadAuthor` and `isReplyAuthor` from the `isMine` flag, `mentionedMe` and
`mentionedMeUnreplied` by checking reply HTML for the user's email address, and `resolved`
from the accepted/rejected status. The extension merge also applies comment-like inbox
status rules (see docs/inbox-states.md): new suggestions get status based on mention,
doc role, and participation; existing suggestions are promoted to INBOX on new activity
when relevant (e.g., new replies mentioning me, or new activity on a suggestion I'm
involved in). MUTED suggestions are only promoted when a new reply @-mentions me.

**Future:** `isThreadAuthor`, `isReplyAuthor`, `mentionedMe`, and `resolved` could
potentially be derived from parsed Gmail notifications but are left for later.

### Merge scenarios

**Drive syncs first (typical):** Creates row with `googleSuggestionId` + content hash.
Gmail merge later finds by content hash, fills in `googleCommentId`, `replyCount`,
overwrites `driveCreatedAt` with the Gmail notification timestamp (more accurate than
Drive's `doc.lastModifiedInDrive` approximation), and updates `driveModifiedAt` from
the last reply timestamp if newer. If the suggestion is `ARCHIVED`, Gmail merge promotes
it to `INBOX` (a notification means interesting activity). `MUTED` suggestions are left
alone.

**Gmail arrives first:** Inserts row with `googleCommentId`, content hash, `suggestionType`,
`driveCreatedAt` from Gmail time, `replyCount`, and `status: "INBOX"`. Drive sync later finds by content hash
and fills in `googleSuggestionId`. The Gmail timestamp is preserved as `driveCreatedAt`.

**No unique hash match:** If content hash matches zero or multiple rows, Drive sync inserts
a new record. This may create duplicates for the same suggestion — see below.

### Resolution and cleanup

When the Docs API is scanned, only pending (unresolved) suggestions appear in the document
body. After upserting live suggestions, any suggestion row in the DB that is not in the
live set is marked `resolved: true` and archived. The resolution check uses two criteria:

- Rows with a `googleSuggestionId`: resolved if not in the live set (normal case)
- Rows without a `googleSuggestionId` (extension-only or Gmail-first rows): checked by
  content hash against live suggestions. If a live suggestion has the same hash, the row
  is kept (it likely represents that suggestion). Only resolved if no live suggestion
  matches by hash.

This means extension-only rows (which have a disco ID but no `googleSuggestionId`) are
not wrongly resolved when their suggestion is still live. Gmail-first rows that Drive
can't correlate are still self-correcting — they get resolved once the suggestion
disappears from the document and no hash match remains.

### Event ordering

The merge is designed to reach a clean final state regardless of the order that Drive
syncs and Gmail notifications arrive.

**Drive first → resolved → Gmail arrives:** Drive creates the row. Next refresh resolves
it (gone from doc). Gmail merge finds the resolved row by hash (hash lookup doesn't filter
by resolved), merges in the comment ID. Final state: one resolved row with both IDs.

**Gmail first → Drive matches:** Gmail inserts a row. Drive sync finds it by hash fallback,
fills in `googleSuggestionId`. Resolution check sees the ID in the live set — not resolved.
When the suggestion is later accepted, the next refresh resolves it normally. Clean.

**Gmail first → suggestion already resolved before Drive syncs:** Gmail inserts a row
with `resolved: false`. Drive sync doesn't find the suggestion in the doc, so the hash
lookup is never attempted. Resolution check: no `googleSuggestionId` and no hash match
among live suggestions → resolved. Clean after one refresh.

### Hash mismatch scenarios

If text normalization differences prevent a hash match, duplicate rows can occur.
All cases self-correct:

**Drive first, Gmail can't match:** Drive row A has `googleSuggestionId`. Gmail inserts
row B with `googleCommentId` and a different hash. Next refresh: row B has no
`googleSuggestionId` → resolved and archived. Row A remains the live record. If the
suggestion is later accepted, row A is also resolved. Both rows end up resolved.

**Gmail first, Drive can't match:** Gmail inserts row B. Drive creates row A with
`googleSuggestionId`. Resolution check resolves row B (no `googleSuggestionId`). Same
outcome as above.

**Consequence of hash mismatch:** The Drive row never gets a `googleCommentId`, so it
won't have a `?disco=` deep link. This is inherent — we can't merge what we can't
correlate. The user may briefly see a duplicate suggestion in INBOX, but it disappears
after the next refresh when the unmatched row is resolved.

---

## Extension Source (DOM Scraping)

When the Chrome extension is installed and a Google Docs tab is open for the document,
the comments page can fetch suggestion data directly from the DOM via `getSuggestions()`.
This provides richer data than either the Docs API or Gmail:

| Data | Docs API | Gmail | Extension |
|------|----------|-------|-----------|
| Suggestion type + text | Yes | Yes | Yes |
| Author name | No | No | Yes |
| isMine flag | No | No | Yes |
| Status (open/accepted/rejected) | Pending only | No | Yes |
| Reply threads with content | No | Count only | Yes (with HTML) |
| Timestamps | Approximate | Minute precision | Relative from DOM |
| Disco ID (for navigation) | No | Yes | Yes |

**Display flow:** On the comments page, after pinging the extension, `fetchExtensionSuggestions()`
calls `getSuggestionsFromDoc(docId)` via the bridge. The extension executes `getSuggestions()`
in the doc tab's MAIN world and returns the results. If the doc isn't open yet (no suggestions
returned), the extension will send a `docReady` event when the doc's stream view appears later,
triggering an automatic one-time fetch without requiring a manual Refresh. These are then:
1. Converted to `CommentThread` and `SuggestionContent` entries for thread panel display
   (reply text, HTML content, author info — data not available from the DB)
2. POSTed to `POST /api/docs/[docId]/extension-suggestions` for DB merge via content-hash
   matching (same algorithm as Gmail merge). The returned DB records replace the suggestion
   entries in the comments list.

**Timestamps:** The extension returns relative timestamps from the DOM (e.g., "6:29 PM Feb 21",
"5:06 AM Yesterday"). These are parsed into `Date` objects for the created/modified columns
where possible; unparseable strings are displayed as-is in the thread panel.

**Per-suggestion refresh:** The expanded suggestion panel has a Refresh button that
re-scrapes a single suggestion by disco ID from the doc tab via `getSuggestionFromDoc()`.
The button is disabled (greyed out with tooltip) when the suggestion has no disco ID or
the extension isn't available. On success, the thread and suggestion content update locally
for immediate display, and the suggestion is pushed to the server for DB merge via
`mergeExtensionSuggestions()` (same endpoint as the page-level extension sync).

**Limitations:** Only works when a doc tab is open. Only sees suggestions visible in the DOM
(anchored sidebar for open suggestions; resolved ones require that the comments pane was
opened at least once during the session — they remain loaded after the pane is closed).
Extension suggestions are not persisted — they exist only for the current page session.

---

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
`driveModifiedAt` is initialized to the same value; the Modified column shows "—" when
it equals `driveCreatedAt`. Gmail merge and extension sync update `driveModifiedAt` with
actual reply timestamps when available.

### Limited isThreadAuthor / isReplyAuthor / mentionedMe

Authorship, reply participation, and @mention flags for suggestions default to `false`
from the Docs API (which provides no comment metadata). When the Chrome extension is
available, the extension merge populates these from DOM-scraped data: `isThreadAuthor`
and `isReplyAuthor` from the `isMine` flag on the suggestion and its replies, and
`mentionedMe`/`mentionedMeUnreplied` by checking reply HTML for the user's email.
Without the extension, "Mine", "Replied", and "@mentioned" filters have no effect on
suggestions.

### Suggestion text content

Suggestion text (inserted and deleted strings) is fetched on page load via `fetchDocContent`,
which makes a single `documents.get` call with `SUGGESTIONS_INLINE` and `includeTabsContent: true`
to extract both suggestion content and document body text from all tabs. Results are keyed by
`suggest.xxx` (`googleSuggestionId`) and display correctly for all suggestion records.

### Non-text suggestions (formatting, links, etc.)

Not all suggestions involve text changes. Formatting suggestions (bold, italic, font changes),
link additions/removals, and other style changes modify text properties without inserting or
deleting text. These are detected via two paths:

1. **Docs API**: `fetchDocData` requests `suggestedTextStyleChanges` on text runs. For
   suggestion IDs that appear only in style changes (not in `suggestedInsertionIds` or
   `suggestedDeletionIds`), a human-readable `description` is generated from the style
   change flags (e.g., "Bold", "Add link: https://...", "Font: Arial"). Note that
   `SUGGESTIONS_INLINE` mode represents formatting changes as delete + insert of identical
   text with different styling — these are detected by comparing inserted vs deleted text.
2. **Chrome extension**: `getSuggestions()` captures the full description text from the DOM
   for suggestions whose type is not Replace/Add/Delete (e.g., "Format: Bold, Italic").

The description flows through `SuggestionContent.description` and is displayed in the UI
instead of the old/new text diff. The anchor text (the text being reformatted) is captured
from `run.content` and displayed in a blockquote, matching the comment anchor text style.

Non-text suggestions use `suggestionType: OTHER` in the DB with empty `insertedText` and
`deletedText`. Their content hashes all collide (`OTHER||`), but primary matching uses
`googleSuggestionId` or `googleCommentId`, so this is acceptable.

### Permissions and View-Only Access

If a user has "Viewer" access to a document but lacks permission to view suggestions or comments, the Docs API call with `suggestionsViewMode: "SUGGESTIONS_INLINE"` will fail with a `403 Forbidden` error indicating `permission to access the document suggestions`. 

Docreview handles this gracefully:
- In `fetchDocContent`, it logs a warning and retries the fetch *without* requesting suggestions so the document text can still be displayed.
- In `syncComments`, the suggestion fetch is skipped, and a warning is logged. Existing suggestions in the database are left untouched (not incorrectly marked as resolved).
- In `fetchAllThreads` (which powers the thread view for the UI), 403 errors are caught and logged as warnings, returning empty lists so the page can continue functioning and load the document text.

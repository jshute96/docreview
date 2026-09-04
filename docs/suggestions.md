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
`suggestionsViewMode: "SUGGESTIONS_INLINE"` and `includeTabsContent: true`, then
recursively walks the structural elements of every tab (including nested child tabs,
tables, and table-of-contents blocks) to collect all pending suggestion IDs (`suggest.xxx`). Each is upserted into the Comment table:

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

**Observed source behavior.** Each source exposes suggestion/comment text
differently, and the normalizer rules below are driven by these observations:

| Source | Whitespace | Length | Truncation marker |
|--------|------------|--------|-------------------|
| Docs API (`documents.get`) | Verbatim, including paragraph-crossing newlines | Full | — |
| Drive API (`comments.get`) | Verbatim | Full | — |
| Gmail notification body | Trimmed and whitespace runs collapsed to one space | ~100 chars | Single-character `…` glyph |
| Docs UI (extension scrape) | Trimmed and collapsed | ~100 chars | Single-character `…` glyph |

Because Gmail and the extension both ship pre-truncated + collapsed text while
the Docs/Drive APIs ship full text, the hash can only match if we apply the
strictest treatment of the three sources to every input.

**Text Normalization:** To ensure the Docs API and Gmail hashes match, both strings are
normalized before hashing:
1. Trailing ellipses (both `...` and `…`) are removed — this allows truncated Gmail
   text to match full Docs API text.
2. Strings are trimmed and all whitespace sequences (including newlines) are replaced
   by a single space.
3. The normalized string is truncated to 100 characters.
4. Truncated strings are trimmed again to ensure no trailing spaces.

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
| `suggestionContentHash` | computed from text | computed from text | Drive & Extension refresh on each sync; Gmail only fills when missing |
| `type` | SUGGESTION | SUGGESTION | Either |
| `suggestionType` | INSERT/DELETE/EDIT/OTHER | mappable from Add/Delete/Replace/Other | Either |
| `resolved` | lifecycle (false→true) | — | Drive authoritative |
| `driveCreatedAt` | `doc.lastModifiedInDrive` (approx) | `time` (minute precision) | Gmail preferred (more accurate) |
| `driveModifiedAt` | `doc.lastModifiedInDrive` (approx) | `time` (minute precision) | Gmail preferred; extension updates with last reply timestamp |
| `replyCount` | 0 (always) | `replies.length` | High-water mark: `max(existing, replies.length)` |
| `replySlotCount` | 0 (always) | `replies.length` (a lower bound) | High-water mark against the slot column. A notification lists only the messages Gmail shows, never deleted ones, so N replies proves there are *at least* N slots — see below. |
| `isThreadAuthor` | false | — | false |
| `isReplyAuthor` | false | — | false |
| `mentionedMe` | false | — | false |
| `readSlotCount` / `readMessageCount` | 0 (default) | 0 (default) | Extension authoritative (messages through my last contribution) |

**Extension source:** When extension suggestions are merged into the DB, the merge also
populates `isThreadAuthor` and `isReplyAuthor` from the `isMine` flag, `mentionedMe` and
`mentionedMeUnreplied` by checking reply HTML for the user's email address, `resolved`
from the accepted/rejected status, and `readSlotCount` from where my last action (reply
or accept/reject) falls in the thread — see docs/comment-tracking.md#read-tracking. The extension merge also applies comment-like inbox status
rules (see docs/inbox-states.md): new suggestions get status based on mention, doc
role, and participation; existing suggestions are promoted to INBOX on new activity
when relevant (e.g., new replies mentioning me, or new activity on a suggestion I'm
involved in). MUTED suggestions are only promoted when a new reply @-mentions me.
`replySlotCount` takes a high-water mark against its stored value, exactly as the Gmail
path does and for the same reason: the extension scrapes the rendered thread, which hides
deleted replies, so its count is a live one and only a lower bound on slots. Writing it
straight through would undo a higher value Gmail had already established, and the next
Drive sync would read the difference as new replies. `replyCount` is a plain overwrite --
it is what the thread draws now.
The `suggestionContentHash` is refreshed in case the formula or suggestion content
changed — the extension reads live content, so two snapshots taken at different
times may yield different hashes, and refreshing lets a later match succeed once
all sources are caught up. The Docs API path refreshes the hash on the same
grounds. Gmail merge, by contrast, only fills the hash when it is missing: Gmail
notification text is a point-in-time snapshot (often truncated with an ellipsis),
so it should not override a fresh hash written by Drive or Extension.
Doc-level unarchive is gated on the thread being unread, so my own last action (typing a
reply, accepting/rejecting) won't resurface an archived doc.

**Gmail reply counts:** A notification carries no read state and never lists deleted
replies, so the merge takes each count as a high-water mark against its own column and
leaves the read boundary alone. Because the boundary is a *read* count, raising the total
is by itself what makes the new replies unread. Raising `replySlotCount` matters for what
happens next: if it lagged, the following Drive sync would see the true slot count exceed
it, read that as new replies, and mark the thread unread a second time — including replies
the user had already read through the notification. On a thread that has a tombstone the
bound is loose (Gmail can't see the deleted reply), so the slot count can still lag; it
only ever errs low, which over-reports later but never hides a reply.

That guarantee covers `replySlotCount` only — `replyCount` is a live count and *can* hide a
reply. See [Read tracking can't see deleted replies](#read-tracking-cant-see-deleted-replies).

**Future:** `isThreadAuthor`, `isReplyAuthor`, `mentionedMe`, and `resolved` could
potentially be derived from parsed Gmail notifications but are left for later.

### Merge scenarios

**Drive syncs first (typical):** Creates row with `googleSuggestionId` + content hash.
Gmail merge later finds by content hash, fills in `googleCommentId`, raises both reply
counts to their high-water marks,
overwrites `driveCreatedAt` with the Gmail notification timestamp (more accurate than
Drive's `doc.lastModifiedInDrive` approximation), and updates `driveModifiedAt` from
the last reply timestamp if newer. If the suggestion is `ARCHIVED`, Gmail merge promotes
it to `INBOX` (a notification means interesting activity). `MUTED` suggestions are left
alone. Both promotion and insertion set `shouldUnarchive`, which moves the parent doc
from ARCHIVED to INBOX via `unarchiveDocIfNeeded()`.

**Gmail arrives first:** Inserts row with `googleCommentId`, content hash, `suggestionType`,
`driveCreatedAt` from Gmail time, both reply counts, and `status: "INBOX"`. Drive sync later finds by content hash
and fills in `googleSuggestionId`. The Gmail timestamp is preserved as `driveCreatedAt`.

**Disco-only / Suggestion-only merge:** If a sync path (Extension, Gmail, or Docs API) finds
an existing record by one ID (e.g., disco ID) but that record is missing the other ID (e.g.,
suggestion ID), it looks for a "partner" record with the same content hash that has the
missing ID but no disco ID. If exactly one such partner is found, the two records are merged
into one, and the partner record is deleted. This handles cases where different sources
initially created separate records for the same suggestion.

**No unique hash match:** If content hash matches zero or multiple rows, Drive sync inserts
a new record. This may create duplicates for the same suggestion — see below.

### Resolution and cleanup

When the Docs API is scanned, only pending (unresolved) suggestions appear in the document
body. After upserting live suggestions, any suggestion row **with a `googleSuggestionId`**
that is not in the live set is marked `resolved: true` and archived.

Rows without a `googleSuggestionId` (extension-only or Gmail-first rows) are **never
resolved by the Docs API sync**. The Docs API cannot reliably determine whether these
suggestions are gone — content hash matching is too fragile (normalization differences,
formatting suggestions with colliding hashes). These rows are resolved when the Chrome
extension reports `accepted`/`rejected` status from the DOM.

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
lookup is never attempted. The row has no `googleSuggestionId`, so the Docs API sync
leaves it alone. It will be resolved when the extension reports accepted/rejected status.

### Hash mismatch scenarios

If text normalization differences prevent a hash match, duplicate rows can occur:

**Drive first, Gmail can't match:** Drive row A has `googleSuggestionId`. Gmail inserts
row B with `googleCommentId` and a different hash. Row B has no `googleSuggestionId`, so
the Docs API sync never resolves it. It will be resolved when the extension reports
accepted/rejected status, or remain as a stale duplicate if the extension never sees it.
Row A is resolved normally when the suggestion leaves the document.

**Gmail first, Drive can't match:** Gmail inserts row B. Drive creates row A with
`googleSuggestionId`. Row B remains unresolved by the Docs API sync (no
`googleSuggestionId`). Same outcome as above.

**Consequence of hash mismatch:** The Drive row never gets a `googleCommentId`, so it
won't have a `?disco=` deep link. This is inherent — we can't merge what we can't
correlate. The user may see a duplicate suggestion. Without the extension, the
Gmail/extension-only row won't be auto-resolved — this is acceptable because incorrectly
resolving live suggestions (the previous behavior) was worse than leaving stale duplicates.

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
| Tab name | No | No | Yes |
| Disco ID (for navigation) | No | Yes | Yes |

**Display flow:** On the comments page, after pinging the extension, `fetchExtensionCommentsAndSuggestions()`
calls `getCommentsAndSuggestionsFromDoc(docId)` via the bridge. This makes a single call to
the extension which executes both `getSuggestions()` and `getComments()` in the doc tab's
MAIN world. For suggestions, the full data is returned; for comments, only `id` and
`originalContentDeleted` are returned (since the Drive API provides everything else).
If the doc isn't open yet (no data returned), the extension will send a `docReady` event
when the doc's stream view appears later, triggering an automatic one-time fetch without
requiring a manual Refresh. The suggestion results are then:
1. Converted to `CommentThread` and `SuggestionContent` entries for thread panel display
   (reply text, HTML content, author info, tab name — data not available from the DB)
2. POSTed to `POST /api/docs/[docId]/extension-suggestions` for DB merge via content-hash
   matching (same algorithm as Gmail merge). The returned DB records replace the suggestion
   entries in the comments list.

The comment `originalContentDeleted` flags are merged into the existing thread map entries
so the "Original content deleted" warning appears for orphaned comments (see
docs/comment-tracking.md).

**Partial scrapes:** Disco ID extraction can fail on list items whose Closure click handlers
aren't wired up yet. Those items are **dropped, never given a placeholder ID** — see
"Missing disco IDs are transient, never placeholders" in docs/comment-tracking.md for why a
synthetic ID corrupts the row permanently. The extension retries the scrape in-page (3
attempts, 200ms apart, bounded by a deadline so the retries can't push the round-trip past
the bridge timeout) and reports any remaining drops as `missingIdCount`. When
`missingIdCount > 0`, `fetchExtensionCommentsAndSuggestions()` merges the suggestions it did
get but leaves `extensionSuggestionsLoaded` clear and schedules a re-fetch (3 retries, 2s
apart) rather than freezing the page on incomplete data. As a backstop,
`mergeExtensionSuggestions()` independently filters ids with `isDiscoId()` (`src/lib/disco-id.ts`)
and reports the count as `skipped` in the response, so a stale extension build can't write a
bad ID into `googleCommentId`; a non-zero `skipped` also marks the fetch partial and triggers
the same retry.

**Timestamps:** The extension returns relative timestamps from the DOM (e.g., "6:29 PM Feb 21",
"5:06 AM Yesterday"). `parseExtensionTimestamp()` resolves these to real
`Date`s (assuming the current year, rolling back a year if that lands in the future), used
both for the created/modified columns and for the thread panel, so extension-sourced
timestamps are formatted the same way as Drive-sourced ones. Unparseable strings (including any year-less
format the parser doesn't recognize, which would otherwise land in year 2001) are shown
verbatim in the thread panel; the created/modified columns show a dash for them.

**Per-suggestion refresh:** The expanded suggestion panel has a Refresh button that
re-scrapes a single suggestion by disco ID from the doc tab via `getSuggestionFromDoc()`.
The button is disabled (greyed out with tooltip) when the suggestion has no disco ID or
the extension isn't available. On success, the thread and suggestion content update locally
for immediate display, and the suggestion is pushed to the server for DB merge via
`mergeExtensionSuggestions()` (same endpoint as the page-level extension sync).

**Per-comment refresh:** When a comment thread is refreshed (via the Refresh button on
an expanded comment), the Drive API thread data is fetched first. After that completes,
`getCommentFromDoc()` checks the extension for the comment's `originalContentDeleted`
status and `tabName`, and merges them into the thread data. These extension-sourced
fields (`originalContentDeleted`, `tabName`) are preserved across Drive API refreshes
(which don't carry them) to avoid flickering.

**Orphaned suggestions:** When the text a suggestion was anchored to is deleted from the
document, Google Docs marks it as orphaned — the Comments panel shows "Original content
deleted" above these items. The extension detects this via the aria-label (which includes
"The original content is deleted." for orphaned items) and sets `originalContentDeleted: true`
on the suggestion. This propagates through `extensionToThread()` to `CommentThread` and is
displayed as a warning on the comments page: "Original content deleted. This suggestion is
not visible in the document." This takes priority over the weaker heuristic that compares
`quotedFileContent` against the current document text. When the extension merge inserts a
new suggestion row with `originalContentDeleted`, it is treated like a resolved suggestion
for initial status — archived by default (unless @-mentioned).

Note: the `docos-docoview-tesla-conflict` CSS class and the orphaned header div appear on
ALL stream-view items when the Comments panel is open, so they are unreliable for detection.
The aria-label is the only reliable signal.

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

### No editing, deleting, accepting, or rejecting

The Docs API offers only `documents.get` and `documents.batchUpdate`, and `batchUpdate`
always writes direct edits — there is no operation to accept, reject, edit, or delete a
suggestion, and no way to write one either. Drive's comment endpoints can't stand in,
since they don't reliably surface suggestion threads (see above). So Docreview's
edit/delete menu is offered on comments only, and `/api/docs/[docId]/threads/edit`
rejects suggestion records with a 400.

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

### Read tracking can't see deleted replies

No suggestion source reports deleted replies. The Docs API returns no reply data at all;
Gmail notifications and the extension's DOM scrape list only what Google currently renders,
and Google hides deletions. Comments are protected against this by Drive's tombstones, which
hold a deleted reply's slot so the read boundary is anchored to positions that never move
(see [comment-tracking.md](./comment-tracking.md#read-tracking)) — suggestions have no
equivalent, so their boundary is a plain count against a live count. Two things follow:

- **A deletion below the boundary slides it.** Deleting a reply the user had already read
  shifts every later message down one, so the boundary covers one message too many and the
  first unread reply is silently credited as read.
- **A deletion can cancel out a new reply.** `replyCount` is stored as
  `max(source's live count, stored)`. A deletion and a new reply between two syncs leave the
  live count unchanged, so the max writes nothing and the new reply never becomes unread.

A third effect is cosmetic: because `replyCount` only ratchets up, a deleted reply leaves the
total inflated on a suggestion Gmail is the only source for, showing a phantom unread message
until an extension sync overwrites the count or the user marks the thread read.

All three are known and accepted — most suggestions never get a reply thread, a reply being
*deleted* on one is rarer still, and the error is one message wide and clears on the next
activity in the thread. A timestamp-based read watermark was considered and rejected; the
reasoning, and the identity-based mechanism to use if this ever needs to be exact, are in
[comment-tracking.md](./comment-tracking.md#suggestions-have-no-tombstones-and-what-that-costs).

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
For text-change suggestions (INSERT/DELETE/EDIT), the anchor text blockquote is suppressed
— the old/new text already conveys the same information. Only non-text suggestions show
the anchor text blockquote.

Non-text suggestions use `suggestionType: OTHER` in the DB with empty `insertedText` and
`deletedText`. Their content hashes all collide (`OTHER||`), but primary matching uses
`googleSuggestionId` or `googleCommentId`, so this is acceptable.

### Permissions and View-Only Access

If a user has "Viewer" access to a document but lacks permission to view suggestions or comments, the Docs API call with `suggestionsViewMode: "SUGGESTIONS_INLINE"` will fail with a `403 Forbidden` error indicating `permission to access the document suggestions`. 

Docreview handles this gracefully:
- In `fetchDocContent`, it logs a warning and retries the fetch *without* requesting suggestions so the document text can still be displayed.
- In `syncComments`, the suggestion fetch is skipped, and a warning is logged. Existing suggestions in the database are left untouched (not incorrectly marked as resolved).
- In `fetchAllThreads` (which powers the thread view for the UI), 403 errors are caught and logged as warnings, returning empty lists so the page can continue functioning and load the document text.

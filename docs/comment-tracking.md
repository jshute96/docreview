# Comment Thread Tracking

## Overview

Docreview syncs comment threads from Google Drive on every refresh. The goal is to surface
comments that need your attention — threads where someone replied to you, re-opened a
discussion, or where a conversation is still active.

**Active comment count** is shown per doc in the main table. A comment is "Active" if it's a
thread you care about that hasn't been resolved (or that was resolved by someone else, meaning
it may need follow-up). A blank cell means no threads currently demand attention.

The **doc detail page** (`/docs/[id]`) shows all comment threads for a single doc with full
filter and sort controls.

---

## Comment Fields

| Field | Source | Description |
|-------|--------|-------------|
| `resolved` | Drive | Whether the thread is marked resolved |
| `isThreadAuthor` | Drive | I created the original comment |
| `iParticipated` | Drive | I'm involved in this thread (authored it or replied, including resolve actions) |
| `iResolvedIt` | Drive | I was the one who resolved it |
| `driveCreatedAt` | Drive | When the comment was originally created |
| `driveModifiedAt` | Drive | When the comment (or any reply) was last modified |
| `replyCount` | Drive | Number of replies to the comment (not counting the original) |
| `status` | User | `ACTIVE`, `ARCHIVED`, or `MUTED` — see below |

---

## Comment Status Values

| Status     | Meaning |
|------------|---------|
| `ACTIVE`   | Needs attention — unresolved or updated by someone else |
| `ARCHIVED` | Resolved; you resolved it yourself, or it was already resolved on first sync |
| `MUTED`    | Permanently hidden from the Active count; user-set, never changed by sync |

---

## Status on First Sync (New Comment)

When a comment thread is seen for the first time:

- **Unresolved** (`resolved = false`) → `ACTIVE`
- **Already resolved** (`resolved = true`) → `ARCHIVED`

Already-resolved threads don't need action, so they start archived.

---

## Deleted Comments

When a comment is deleted in Google Docs, the Drive API simply stops returning it. Since we
don't store comment text (it's fetched live from Drive when the user expands a row), there's
nothing useful left to show — the "Open" link would point at nothing, expanding would 404,
and only bare metadata (dates, reply count) would remain. So during sync, any COMMENT records
in the DB whose `googleCommentId` was not returned by Drive are deleted outright, regardless
of status (ACTIVE, ARCHIVED, or MUTED).

This only runs when `fetchComments` succeeds — if the API call throws, we return early before
reaching the deletion code, so a transient error can never wipe out all comments.

---

## Status on Subsequent Syncs

Every sync does a full `comments.list` scan (incremental sync via `startModifiedTime` was
dropped because it silently excludes suggestions). All existing comments for the doc are
batch-fetched from the database in a single query and compared against Drive results. New
comments are collected and inserted with a single `createMany` call; updates are applied
individually (with no-op detection to skip unchanged records).

**No-op detection:** Before writing an update, each comment's Drive-side fields are compared
against the existing record. If nothing changed, the update is skipped entirely. This avoids
unnecessary writes and makes the "N updated" log count accurate. Date fields are compared
via `.getTime()` with null-handling.

**MUTED**: If status is `MUTED`, it is left unchanged. Muted threads stay hidden regardless
of new Drive activity. Drive-side fields (`resolved`, `iParticipated`, `driveCreatedAt`,
`driveModifiedAt`, `replyCount`) are still updated when they differ, so the detail page
reflects current state.

**For all other statuses**, apply this logic:

1. Compare `resolved`, `iParticipated`, `status`, `driveCreatedAt`, `driveModifiedAt`, and
   `replyCount` against the existing record. Skip the update if all match.
2. If `resolved = true` AND I was the one who resolved it (the last reply with
   `action = "resolve"` has `author.me = true`) → set status to `ARCHIVED`.
3. Otherwise (new reply added, thread re-opened, resolved by someone else) → set status
   to `ACTIVE`.

The effect: threads you close yourself get archived quietly. Anything else surfaces as Active.

---

## MUTED Behavior

`MUTED` is a user-set status, not set by sync logic. Once muted:

- The comment never appears in the Active count.
- Sync never changes its status, even if Drive reports new activity.
- The user must explicitly un-mute to restore tracking.

This is useful for comment threads that are noisy or irrelevant, where you don't want to be
reminded each refresh.

---

## Doc Unarchive Rules

When a doc has been archived by the user, it should only resurface if there's **new meaningful
activity** during the current sync — not just because an old unresolved comment exists.

During `syncComments`, a `shouldUnarchive` flag is tracked. An ARCHIVED doc moves back to
ACTIVE only when this flag is set. Activity is evaluated using an `isInteresting` check:

```ts
const isInteresting = !(c.resolved && c.iResolvedIt) && (
  doc.role === "AUTHOR" || c.iParticipated
);
```

A comment is interesting if I'm the doc author or a participant in the thread, unless I
resolved it myself. This replaces the previous XOR check (`isMine !== doc.role === "AUTHOR"`)
with a simpler model: "does this activity concern me?"

**New comment** (not previously in DB):
- If `isInteresting` → unarchive.
- Doc author sees all new threads; participants see threads they're involved in.

**New replies on existing thread** (`replyCount` increased):
- If the thread is not MUTED and `isInteresting` → unarchive.

**New suggestion** (not previously in DB):
- Unarchive only when `doc.role === "AUTHOR"` (new suggestions on my docs).
- Suggestions have `isThreadAuthor=false` and `iParticipated=false`, so `isInteresting`
  doesn't apply — the check is explicit.

**MUTED threads**: never trigger unarchive, regardless of new activity.

---

## Detail Page Filters

The doc detail page provides three ways to narrow the comment table:

**Show mode** (mutually exclusive):
- **Active** — only comments with `status = ACTIVE` (default)
- **Open** — all unresolved comments regardless of status
- **All** — every comment, including archived and muted

**Toggle filters** (AND-combined with show mode):
- **My threads** — keep only `iParticipated` (since `isThreadAuthor` implies `iParticipated`)
- **My comments** — keep only `isThreadAuthor`

**Search filter**:
The search bar at the top of the table allows filtering comments by text. The search is
case-insensitive and checks against the comment content, suggestion text, and reply threads.
Both regex and literal substring matching are always attempted:
- **Regex**: The search string is tried as a regular expression. Only non-empty regex
  matches are considered (e.g., `x*` won't match every character).
- **Literal substring**: The search string is also checked as a plain case-insensitive
  substring.
- A comment matches if either check succeeds. When highlighting, regex matches are preferred
  if present; otherwise literal matches are highlighted.
- The same logic is used for both filtering (`matchesFilter`) and highlighting
  (`highlightText`), ensuring consistent behavior.

All five data columns (Created, Modified, Responses, Mine, Replied, Status) are sortable.
Modified shows "—" when it equals Created (i.e., no replies have been added).

**Sort freezing on single-comment updates:** When you reply to, resolve, refresh, or
otherwise modify a single comment, its `driveModifiedAt` changes. If the table re-sorted
immediately, that row would jump to a new position — disorienting when you're mid-conversation.
To prevent this, single-comment updates freeze the table order: rows stay where they are and
the sort column icon switches to the unselected state (↕) to signal the displayed order may be
stale. The frozen order is a snapshot of the positions from the last active sort, stored in a
ref. Clicking any column header or the global **Refresh** button reactivates sorting and
restores the sort icon. Comments that get filtered out (e.g., resolved while viewing "Open")
still disappear; only the relative order of remaining rows is preserved.

---

## Suggestions

Suggestions (tracked changes) are a separate comment type (`type: "SUGGESTION"`) and have
their own sync logic. They are displayed in the comment table and can be filtered with the
**Suggestions** toggle. For full details, see [`suggestions.md`](./suggestions.md).

---

## Drive API Notes

- **Endpoint**: `GET /drive/v3/files/{fileId}/comments`
- **`fields` is mandatory** — Drive returns nothing without it.
- **Fields used for sync**: `id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me))`
- **Fields used for thread display**: adds `content, htmlContent, quotedFileContent(mimeType, value), author(displayName), replies(content, htmlContent, createdTime, author(displayName))`
- **`htmlContent`**: Read-only field with HTML formatting of comment/reply text (bold, italics, @mention links). The API recommends displaying `htmlContent` over plain `content`.
- **`quotedFileContent`**: The document text the comment was anchored to at creation time. MIME type is typically `text/html` but in practice the value appears to contain no formatting markup. This is a snapshot — the text may have been edited or deleted since. When the thread panel is shown, the quoted text is checked against the current document body (fetched once on page load via `fetchDocumentText`). If the text is no longer found, a warning is displayed. This check only applies to Google Docs; Sheets and Slides don't fetch document text.
- **`startModifiedTime`**: RFC 3339 timestamp; filters to comments modified after this time.
  Not currently used — incremental comment sync was dropped because this filter silently
  excludes suggestions. Every sync does a full scan instead.
- **File `modifiedTime` does NOT update when comments change.** This is why we cannot use the
  file's modification time as a sync gate.
- Scope: `drive.readonly` is sufficient (already configured).
- Pagination: `comments.list` returns `nextPageToken`; always paginate to completion.

---

## Participation and Reply Count Detection

Each comment object includes author info and a list of replies. The replies array is fetched
once and used for three derived fields:

- **`isThreadAuthor`** — `comment.author.me === true`: I created this thread.
- **`iParticipated`** — `isThreadAuthor || replies.some(r => r.author?.me === true)`:
  Am I involved in this thread at all? Includes thread authorship, substantive replies,
  and resolve actions.
- **`iResolvedIt`** — find the last reply where `action === "resolve"`; true if
  `author.me === true`.
- **`replyCount`** — `replies.length`: total number of replies to the original comment,
  including resolve actions. No extra API call; derived from the already-fetched replies.

# Comment Thread Tracking

## Overview

Docreview syncs comment threads from Google Drive on every refresh. The goal is to surface
comments that need your attention — threads where someone replied to you, re-opened a
discussion, or where a conversation is still active.

**Inbox comment count** is shown per doc in the main table. A comment is in "Inbox" if it's a
thread you care about that hasn't been resolved (or that was resolved by someone else, meaning
it may need follow-up). A blank cell means no threads currently demand attention.

The **doc detail page** (`/docs/[docId]`) shows all comment threads for a single doc with full
filter and sort controls.

---

## Comment Fields

| Field | Source | Description |
|-------|--------|-------------|
| `resolved` | Drive | Whether the thread is marked resolved |
| `isThreadAuthor` | Drive | I created the original comment |
| `isReplyAuthor` | Drive | I authored at least one reply in this thread (including resolve actions) |
| `iResolvedIt` | Drive | I was the one who resolved it |
| `driveCreatedAt` | Drive | When the comment was originally created |
| `driveModifiedAt` | Drive | When the comment (or any reply) was last modified |
| `replyCount` | Drive | Number of replies to the comment (not counting the original) |
| `isRead` | Drive / User | Whether I've read this thread (see below) |
| `assignedToMe` | Drive | The comment is assigned to me via `assigneeEmailAddress` |
| `mentionedMe` | Drive | I was @mentioned anywhere in the thread (comment or any reply). Cleared when `assignedToMe` is true (assignment takes precedence) |
| `mentionedMeUnreplied` | Drive | `mentionedMe` is true and there's no reply/resolve by me after the last mention. Cleared when `assignedToMe` is true |
| `status` | User | `INBOX`, `ARCHIVED`, or `MUTED` — see below |

---

## Comment Status Values

| Status     | Meaning |
|------------|---------|
| `INBOX`    | Needs attention — unresolved or updated by someone else |
| `ARCHIVED` | Resolved; you resolved it yourself, or it was already resolved on first sync |
| `MUTED`    | Hidden from the Inbox count; user-set, only overridden by sync when @-mentioned |

---

## Status on First Sync (New Comment)

When a comment thread is seen for the first time (first matching rule wins):

- **@-mention of me** anywhere in the thread → `INBOX` (even if resolved)
- **Already resolved** (`resolved = true`) → `ARCHIVED`
- **Unresolved** and I'm the doc author (`doc.role === "AUTHOR"`) → `INBOX`
- **Unresolved** and I'm involved (`isThreadAuthor || isReplyAuthor`) → `INBOX`
- **Otherwise** (unresolved but not relevant to me) → `ARCHIVED`

Only comments relevant to the current user start in Inbox. Already-resolved threads
don't need action, and unresolved threads on docs where I'm just a reviewer with no
participation are archived until something involves me. @-mentions override all other
rules — if someone mentions me, I see it regardless.

---

## Deleted Comments

When a comment is deleted in Google Docs, the Drive API simply stops returning it. Since we
don't store comment text in the database (it's fetched from Drive on page load), there's
nothing useful left to show — the "Open" link would point at nothing, expanding would 404,
and only bare metadata (dates, reply count) would remain. So during sync, any COMMENT records
in the DB whose `googleCommentId` was not returned by Drive are deleted outright, regardless
of status (INBOX, ARCHIVED, or MUTED).

This only runs when `fetchComments` succeeds — if the API call throws, we return early before
reaching the deletion code, so a transient error can never wipe out all comments. Permanent
permission errors (403) also return early without triggering deletion, as the document
still exists even if its comments are inaccessible.

---

## Status on Subsequent Syncs

Every sync does a full `comments.list` scan (incremental sync via `startModifiedTime` was
dropped because it silently excludes suggestions). All existing comments for the doc are
batch-fetched from the database in a single query and compared against Drive results. New
comments are collected and inserted with a single `createMany` call; updates are applied
individually (with no-op detection to skip unchanged records).

**No-op detection:** Before writing an update, each comment's Drive-side fields are compared
against the existing record. If nothing changed, the update is skipped entirely. This avoids
unnecessary writes and makes the granular log counts (e.g., "3 updated comment threads") accurate.
Date fields are compared via `.getTime()` with null-handling.

**@-mention in new reply**: If any new reply mentions the current user (via
`mentionedEmailAddresses`), the comment moves to `INBOX` — even if it was `MUTED`. This
is the only case where a comment exits MUTED state.

**MUTED** (without @-mention): If status is `MUTED` and no new reply mentions me, it is
left unchanged. Muted threads stay hidden regardless of new Drive activity. Drive-side
fields (`resolved`, `isReplyAuthor`, `driveCreatedAt`, `driveModifiedAt`, `replyCount`)
are still updated when they differ, so the detail page reflects current state.

**For all other statuses (INBOX, ARCHIVED, or MUTED with @-mention)**, apply this logic
(first matching rule wins):

1. Compare `resolved`, `isReplyAuthor`, `status`, `driveCreatedAt`,
   `driveModifiedAt`, and `replyCount` against the existing record. `isRead` is only
   compared when `driveModifiedAt` has changed (preserving manual toggles). Skip the
   update if all match.
2. If a **new reply @-mentions me** → `INBOX` (overrides all other rules, including MUTED).
3. If `resolved = true` AND I was the one who resolved it → set status to `ARCHIVED`.
4. Otherwise, if there is **new activity** (new replies, thread re-opened, or modification
   detected via `driveModifiedAt`), apply relevance-based rules:
   - **I'm the doc author** → `INBOX` (rule 4: all activity is relevant)
   - **I started the thread** and there are new replies → `INBOX` only if at least one
     reply is from someone else. Self-replies on my own thread don't wake it up (rule 5
     exception). Uses `replyAuthorMeFlags` to detect self vs. other replies.
   - **I participated (replied) on someone else's thread** → `INBOX` (rule 6)
   - **Not relevant to me** → preserve existing status
5. Otherwise (no new activity), preserve the existing `status`. This ensures that if
   you manually archive an unresolved thread, it stays archived until someone replies
   to it or re-opens it.

The effect: threads you close yourself get archived quietly. Manual archiving is preserved.
Activity only surfaces in Inbox when it's relevant to you — not all activity on every thread.

---

## MUTED Behavior

`MUTED` is a user-set status, not normally changed by sync logic. Once muted:

- The comment never appears in the Inbox count.
- Sync never changes its status, even if Drive reports new activity — **except** when a
  new reply @-mentions the current user. This is the only case where MUTED is overridden.
- The user can explicitly un-mute to restore tracking.

This is useful for comment threads that are noisy or irrelevant, where you don't want to be
reminded each refresh.

---

## Doc Unarchive Rules

When a doc has been archived by the user, it should only resurface if there's **new meaningful
activity** during the current sync — not just because an old unresolved comment exists.

During `syncComments`, two flags are tracked:
- `shouldUnarchive` — whether comment-level changes warrant moving the doc back to INBOX
- `hasNonResolveActivity` — whether there was any activity beyond just resolving comments

An ARCHIVED doc moves back to INBOX only when **both** flags are set. This prevents noise
from resolved threads resurfacing a doc you've already dismissed.

### shouldUnarchive triggers

`shouldUnarchive` is set based on the resulting comment status, not a separate heuristic:

1. **New comment with INBOX status** — a new comment that the relevance rules assigned to
   INBOX (doc author or participant) triggers unarchive.
2. **Existing comment transitions to INBOX** — a comment moving from ARCHIVED to INBOX
   (e.g., someone replied on a thread I'm involved in) triggers unarchive.
3. **Existing INBOX comment gets new replies** — even if the comment stays in INBOX, new
   replies on an already-INBOX comment trigger unarchive (unless I resolved it myself).
4. **INBOX comment resolved by someone else** — the resolve is new activity that the user
   should see, even though the comment moves to ARCHIVED.

### hasNonResolveActivity

Tracks whether there's substantive activity beyond comment resolutions:
- New unresolved comment → yes
- New replies that aren't just a resolve action → yes
- Re-opened comment → yes
- New suggestion → yes
- Comment resolved with exactly 1 new reply (the resolve itself) → no

**New suggestion** (not previously in DB):
- Unarchive only when `doc.role === "AUTHOR"` (new suggestions on my docs).
- Always counts as non-resolve activity.

**MUTED threads**: never trigger unarchive, unless an @-mention breaks the thread out of
MUTED (at which point the MUTED→INBOX transition triggers unarchive like any other).

### Manual comment→doc propagation

When a user manually moves a comment to INBOX (via the detail page), the doc is also moved
to INBOX if it was ARCHIVED. This ensures the doc surfaces when the user explicitly marks
a comment as needing attention.

---

## Detail Page Filters

The doc detail page provides three ways to narrow the comment table:

**Show mode** (mutually exclusive):
- **Inbox** — only comments with `status = INBOX` (default)
- **Open** — all unresolved comments regardless of status
- **All** — every comment, including archived and muted

**Tri-state badge filters** (AND-combined with show mode; each cycles off → include → exclude):
- **Mine** — filter by `isThreadAuthor` (I started the thread)
- **Replied** — filter by `isReplyAuthor` (I replied in the thread)
- **Assigned** — filter by `assignedToMe` (comment assigned to me). Only shown when any comment has this status.
- **@Mentioned** — filter by `mentionedMe` (I was @mentioned in the thread). Only shown when any comment has this status.
- **Resolved** — filter by `resolved`
- **Unread** — filter by `!isRead` (someone else was the last to act)
- **Starred** — tri-state star filter (off/starred-only/unstarred-only)
- **Suggestions** — filter by `type = SUGGESTION`

Mine, Replied, Assigned, and @Mentioned badges only appear in the filter bar when at
least one comment in the doc has that status (regardless of current filter/view state).

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

The sortable data columns are Modified, Responses, and Status (which combines star, Mine/Replied/Assigned/@Mentioned badges, and Resolved/Open state into one column). The Assigned badge is shown in a darker style (amber-600) to stand out.
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
- **Fields used for sync**: `id, resolved, createdTime, modifiedTime, author(me), assigneeEmailAddress, mentionedEmailAddresses, replies(action, author(me), mentionedEmailAddresses)`
- **Fields used for thread display**: adds `content, htmlContent, quotedFileContent(mimeType, value), author(displayName), replies(content, htmlContent, createdTime, author(displayName))`
- **`htmlContent`**: Read-only field with HTML formatting of comment/reply text (bold, italics, @mention links). The API recommends displaying `htmlContent` over plain `content`.
- **`quotedFileContent`**: The document text the comment was anchored to at creation time. MIME type is typically `text/html` but in practice the value appears to contain no formatting markup. This is a snapshot — the text may have been edited or deleted since. The Drive API may also truncate long quoted text (the truncation format is undocumented). When the thread panel is shown, the quoted text is checked against the current document body (fetched once on page load via `/api/docs/[docId]/content`). If the text is no longer found, a warning is displayed. For Docs, the text is fetched via `fetchDocContent` (a single Docs API `documents.get` call that also extracts suggestion content); for Slides, via `fetchFileTextViaExport` (Drive `files.export` as `text/plain`). Sheets are not checked. Note: `fetchDocContent` uses `SUGGESTIONS_INLINE` mode, so the document text includes pending suggestion text — anchor-text matching may false-positive if a suggestion overlaps the anchor region, but the consequence is only a spurious warning.
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
- **`isReplyAuthor`** — `replies.some(r => r.author?.me === true)`:
  Did I author any reply in this thread? Includes substantive replies and resolve actions.
  Independent from `isThreadAuthor`; use `isThreadAuthor || isReplyAuthor` for "am I
  involved at all".
- **`iResolvedIt`** — find the last reply where `action === "resolve"`; true if
  `author.me === true`.
- **`isRead`** — Initial value from Drive: if `replies.length > 0`,
  `replies[last].author.me === true`; otherwise `comment.author.me === true`. Can also be
  toggled manually via the "Mark read/unread" button on the comments page. Manual changes
  are sticky: sync only overwrites `isRead` when `driveModifiedAt` changes (i.e., new
  activity on the thread). Used for the **Unreplied** filter, green row highlighting, and
  the unread comment count on the docs page.
- **`replyCount`** — `replies.length`: total number of replies to the original comment,
  including resolve actions. No extra API call; derived from the already-fetched replies.
- **`assignedToMe`** — whether `comment.assigneeEmailAddress` matches the current user's
  email (case-insensitive). Assignment is a comment-level property, not per-reply.
- **`mentionedMe`** (on DriveComment) — whether the initial comment's `mentionedEmailAddresses`
  includes the current user's email (case-insensitive). On the DB record, this is the union
  across the comment and all replies. **Cleared when `assignedToMe` is true** — assignment
  takes precedence over @mention to avoid double-counting (Drive always @mentions the assignee).
- **`mentionedMeUnreplied`** — true when `mentionedMe` is true (in the thread) and there
  is no reply/resolve by me after the last mention. Computed by finding the last mention index
  and checking for a subsequent reply from me. Cleared when `assignedToMe` is true.
- **`replyMentionedMeFlags`** — per-reply boolean array: whether each reply's
  `mentionedEmailAddresses` includes the current user's email. Used alongside
  `replyAuthorMeFlags` to detect new @-mentions in new replies (via `.slice(existing.replyCount)`).
  Cleared (all false) when `assignedToMe` is true.

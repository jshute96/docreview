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
| `assignedToMe` | Drive | The comment was assigned to me (derived from comment + reply `assigneeEmailAddress`; see limitation below) |
| `mentionedMe` | Drive | I was @mentioned anywhere in the thread (comment or any reply). Cleared when `assignedToMe` is true (assignment takes precedence) |
| `mentionedMeUnreplied` | Drive | `mentionedMe` is true and there's no reply/resolve by me after the last mention. Cleared when `assignedToMe` is true |
| `status` | User | `INBOX`, `ARCHIVED`, or `MUTED` — see below |

---

## Comment Status Values

| Status     | Meaning |
|------------|---------|
| `INBOX`    | Needs attention — unresolved or updated by someone else |
| `ARCHIVED` | Resolved; you resolved it yourself, or it was already resolved on first sync |
| `MUTED`    | Hidden from the Inbox count; user-set, only overridden by sync when @-mentioned or assigned in a new reply |

---

## Status on First Sync (New Comment)

When a comment thread is seen for the first time (first matching rule wins):

- **@-mention of me or assigned to me** anywhere in the thread → `INBOX` (even if resolved)
- **Already resolved** (`resolved = true`) → `ARCHIVED`
- **Unresolved** and I'm the doc author (`doc.role === "AUTHOR"`) → `INBOX`
- **Unresolved** and I'm involved (`isThreadAuthor || isReplyAuthor`) → `INBOX`
- **Otherwise** (unresolved but not relevant to me) → `ARCHIVED`

Only comments relevant to the current user start in Inbox. Already-resolved threads
don't need action, and unresolved threads on docs where I'm just a reviewer with no
participation are archived until something involves me. @-mentions and assignments
override all other rules — if someone mentions or assigns me, I see it regardless.

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

### Gmail-Sourced Comments (No Comment Permission)

When Gmail notifications reference docs where the user lacks comment access
(`noCommentsPermission` in the parsed email), `mergeCommentsFromGmail()` in
`comment-merge.ts` inserts comment records from the email body. This is the only
source of comment data for these docs — Drive's `comments.list` returns 403.

Each comment is keyed by `discussionId` (the `disco=` URL parameter). Duplicate
detection uses `findFirst` by docId + googleCommentId. Fields are populated from
the email: author, timestamp, content (text or suggestion placeholder), reply count.
The `source` field is set to `"gmail"` to distinguish from Drive-sourced comments.

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

**@-mention or assignment in new reply**: If any new reply mentions or assigns the current
user, the comment moves to `INBOX` — even if it was `MUTED`. This is the only case where
a comment exits MUTED state.

**MUTED** (without new @-mention or assignment): If status is `MUTED` and no new reply
mentions or assigns me, it is left unchanged. Muted threads stay hidden regardless of new
Drive activity. Drive-side fields (`resolved`, `isReplyAuthor`, `driveCreatedAt`,
`driveModifiedAt`, `replyCount`) are still updated when they differ, so the detail page
reflects current state.

**For all other statuses (INBOX, ARCHIVED, or MUTED with @-mention/assignment)**, apply
this logic (first matching rule wins):

1. Compare `resolved`, `isReplyAuthor`, `status`, `driveCreatedAt`,
   `driveModifiedAt`, and `replyCount` against the existing record. `isRead` is only
   compared when `driveModifiedAt` has changed (preserving manual toggles). Skip the
   update if all match.
2. If a **new reply @-mentions or assigns me** → `INBOX` (overrides all other rules,
   including MUTED).
3. If `resolved = true` AND I was the one who resolved it → set status to `ARCHIVED`.
4. Otherwise, if there is **new activity** (new replies, thread re-opened, or modification
   detected via `driveModifiedAt`), apply relevance-based rules:
   - **I was @-mentioned or assigned** anywhere in the thread → `INBOX` (even if I
     previously archived it; MUTED comments don't reach here)
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
  new reply @-mentions or assigns the current user. This is the only case where MUTED is
  overridden.
- The user can explicitly un-mute to restore tracking.

This is useful for comment threads that are noisy or irrelevant, where you don't want to be
reminded each refresh.

---

## Doc Unarchive Rules

When a doc has been archived by the user, it should only resurface if there's **new meaningful
activity** during the current sync — not just because an old unresolved comment exists.

During sync, the `shouldUnarchive` flag tracks whether comment/suggestion-level changes
warrant moving the doc back to INBOX. An ARCHIVED doc moves back to INBOX when this flag
is set.

The `unarchiveDocIfNeeded()` helper in `sync-comments.ts` encapsulates this check and is
called from three paths:
1. **Bulk/single-doc refresh** (`refresh.ts`) — after `syncComments()` and Gmail suggestion merge
2. **Extension comment sync** (`sync-comments/[googleDocId]/route.ts`) — after `syncComments()`
3. **Extension suggestion merge** (`extension-suggestions/route.ts`) — after `mergeExtensionSuggestions()`

**Recency cutoff (bulk refresh only):** During bulk refresh, an additional check gates
unarchive on the doc's `lastCommentActivity` being newer than a cutoff derived from the
Drive changes feed. This prevents old docs with stale unresolved comments from appearing
in inbox when first synced. See [Phase 3.5 — Smart Unarchive](./refresh.md#phase-35--smart-unarchive).

### shouldUnarchive triggers

`shouldUnarchive` is set based on the resulting comment status, not a separate heuristic:

1. **New comment with INBOX status** — a new comment that the relevance rules assigned to
   INBOX (doc author or participant) triggers unarchive.
2. **Existing comment transitions to INBOX** — a comment moving from ARCHIVED to INBOX
   (e.g., someone replied on a thread I'm involved in) triggers unarchive.
3. **Existing INBOX comment gets new replies** — even if the comment stays in INBOX, new
   replies on an already-INBOX comment trigger unarchive (unless I resolved it myself).
4. **INBOX comment resolved by someone else** — the resolve is new activity that the user
   should see.
5. **New suggestion with INBOX status** — a new suggestion (from Docs API, Gmail, or
   extension) that gets INBOX status triggers unarchive.
6. **Existing suggestion promoted to INBOX** — a suggestion moving from ARCHIVED to INBOX
   (e.g., Gmail merge or extension merge detects new activity) triggers unarchive.

**New suggestion** (not previously in DB):
- **Docs API path**: `status: "INBOX"` when `doc.role === "AUTHOR"`; otherwise `"ARCHIVED"`.
  The Docs API has no participation/mention data, so only doc role is checked.
- **Extension path**: applies comment-like rules — `@-mention → INBOX`, `resolved → ARCHIVED`,
  `doc author or participant → INBOX`, otherwise `ARCHIVED`.
- **Extension enrichment**: when the extension first enriches a Docs API-created suggestion
  (adding the disco ID), the initial status is re-evaluated with the now-available
  participation data. This corrects cases like "my suggestion on a REVIEWER doc" from
  ARCHIVED to INBOX.
- **Gmail-first inserts**: always `"INBOX"` (notification = interesting activity).
- Gmail merge promotes `ARCHIVED` suggestions to `INBOX`; `MUTED` stays `MUTED`.
- Extension merge applies activity-based status transitions on existing suggestions
  (same rules as comments: new reply @-mention breaks MUTED, new activity + relevance
  promotes ARCHIVED → INBOX).

**Suggestion resolution** (extension sync only — Docs API marks resolved but has no
authorship data):
- I accepted/rejected someone else's suggestion → `ARCHIVED`.
- My suggestion, accepted with no discussion replies → `ARCHIVED` (silent accept,
  nothing interesting to see).
- My suggestion, rejected → stays in current status (may need follow-up).
- My suggestion, accepted/rejected with discussion replies → stays in current status
  (conversation worth reviewing).
- Unarchive (doc level) only when `doc.role === "AUTHOR"` (new suggestions on my docs).
- Always counts as non-resolve activity.

**MUTED threads**: never trigger unarchive, unless an @-mention or assignment breaks the
thread out of MUTED (at which point the MUTED→INBOX transition triggers unarchive like
any other).

### Manual comment→doc propagation

When a user manually moves a comment to INBOX (via the detail page), the doc is also moved
to INBOX if it was ARCHIVED. This ensures the doc surfaces when the user explicitly marks
a comment as needing attention.

---

## Last Comment Activity Tracking

The `lastCommentActivity` field on the `Doc` record tracks the most recent comment or
suggestion timestamp seen during sync. It is updated atomically (via SQL `GREATEST`) whenever
a comment or suggestion is created, updated, or resolved, using `MAX(driveCreatedAt, driveModifiedAt)`
from the affected record. This means it only moves forward, never backwards.

When comments are deleted from Drive, `lastCommentActivity` is **not** rolled back — the value
may exceed any current comment's timestamp. This is intentional: there *was* activity at that
time, and the field reflects "most recent activity ever seen", not "most recent surviving comment".

Initialized from `createdTimeInDrive` when a doc is first added (before any comments are synced).

Used in the docs table UI as a sortable "Last Comment" column (default sort, descending).

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

**Row highlighting** (both comments page and docs page):
- **Red background** — comment is in INBOX, assigned to me, and unresolved. On the docs page, the doc row is red if any comment matches.
- **Amber background** — comment is in INBOX, has an unreplied @-mention of me, is unread, and unresolved. On the docs page, the doc row is amber if any comment matches.
- **Green background** — comment is read (default read state). Only shown when neither red nor amber applies.
- Red takes precedence over amber; both take precedence over green.

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

## Comments vs Suggestions

Google Docs has two distinct annotation features that Docreview tracks in the same `Comment`
table but syncs from different APIs:

| | Comments | Suggestions |
|---|---|---|
| **What they are** | Threaded discussions attached to selected text | Tracked changes (insertions, deletions, replacements) |
| **Created by** | Insert menu or comment icon on selected text | Switching to "Suggesting" mode and typing |
| **API source** | Drive API (`comments.list`, `comments.get`) | Docs API (`documents.get` with `SUGGESTIONS_INLINE`) |
| **DB type** | `COMMENT` | `SUGGESTION` |
| **ID format** | `googleCommentId` — Drive comment ID (`AAAB...`) | `googleSuggestionId` — Docs API ID (`suggest.xxx`) |
| **Replies** | Full thread with reply count, author tracking, @mentions | Not tracked by Docs API; available when Chrome extension provides DOM data |
| **Status fields** | `isThreadAuthor`, `isReplyAuthor`, `mentionedMe`, etc. from Drive | Default to `false` from Docs API; populated by extension merge when available |
| **Resolution** | Resolved/reopened via Drive API | Accepted/rejected — disappears from doc body |
| **Navigation** | `?disco=` with `googleCommentId` | `?disco=` with `googleCommentId` when available (see below) |

### ID formats and navigation

Both comments and suggestions have Drive comment IDs (`AAAB...`), visible in the Closure
Library component tree attached to their DOM list items. For comments, this ID is the
primary identifier — it's used in Drive API calls, DB lookups, and `?disco=` navigation.

Suggestions also have these `AAAB...` IDs in the DOM, and they work for `?disco=` navigation
(scrolling to the suggestion in the document). However, they **cannot be used in Drive API
calls** — `comments.get` with a suggestion's `AAAB...` ID doesn't reliably return data. The
Docs API uses a separate `suggest.xxx` ID format. When a suggestion has a `googleCommentId`
(from Gmail notification merge), Docreview uses it for `?disco=` deep links. Otherwise the
doc opens without scrolling to the suggestion.

### Extension sync implications

When the Chrome extension detects user actions on comment buttons, it determines `commentType`
by checking for Accept/Reject buttons in the parent list item:

- **Comment thread** (no Accept/Reject): `commentType='comment'` → server syncs from Drive API
  only, skipping the Docs API suggestion fetch. If a disco ID was extracted, uses
  `syncSingleComment` for a targeted single-comment update.
- **Suggestion thread** (Accept/Reject present): `commentType='suggestion'` → server syncs from
  Docs API only, skipping the Drive API comment fetch. Disco IDs are extracted (for logging)
  but not used for single-comment sync (suggestion IDs can't be used in Drive API calls).

Replies on suggestion threads are tagged as `commentType='suggestion'`. The Docs API sync checks
whether the suggestion still exists (for accept/reject detection) but doesn't track replies.
This is acceptable because Docreview doesn't display suggestion replies.

After server-side sync completes, the extension parses the sync response and notifies open
Docreview tabs with `commentSynced` (including `googleCommentId`, `commentType`, and thread
display data when available from single-comment sync). The client uses the inline thread data
directly, merging it into the existing thread map — no additional Drive API call is needed.
For suggestions or when no thread data is available, it falls back to a full `comments.list`.

For full suggestion sync details, see [`suggestions.md`](./suggestions.md).

---

## Drive API Notes

- **Endpoint**: `GET /drive/v3/files/{fileId}/comments`
- **`fields` is mandatory** — Drive returns nothing without it.
- **Fields used for sync**: `id, resolved, createdTime, modifiedTime, author(me), assigneeEmailAddress, mentionedEmailAddresses, replies(action, author(me), assigneeEmailAddress, mentionedEmailAddresses)`
- **Fields used for thread display**: adds `content, htmlContent, quotedFileContent(mimeType, value), author(displayName), replies(content, htmlContent, createdTime, author(displayName))`
- **`htmlContent`**: Read-only field with HTML formatting of comment/reply text (bold, italics, @mention links). The API recommends displaying `htmlContent` over plain `content`.
- **`quotedFileContent`**: The document text the comment was anchored to at creation time. MIME type is typically `text/html` but in practice the value appears to contain no formatting markup. This is a snapshot — the text may have been edited or deleted since. The Drive API may also truncate long quoted text (the truncation format is undocumented). The thread panel shows one of three warnings when the quoted text doesn't match the current document, based on `originalContentDeleted` (a tri-state from the Chrome extension: `true` = deleted, `false` = checked & not deleted, `undefined` = not checked):
  - **`true`**: "Original content deleted. This comment/suggestion is not visible in the document." — definitive orphaned warning from the extension's aria-label detection.
  - **`false`** (text not found but extension says still anchored): "This is the original text from when the comment was created." — the text changed but the comment is still attached.
  - **`undefined`** (text not found, no extension data): "This text no longer exists in the document. This comment might not be visible." — uncertain, could be deleted or just edited.
  For Docs, the document text is fetched via `fetchDocContent` (a single Docs API `documents.get` call that also extracts suggestion content); for Slides, via `fetchFileTextViaExport` (Drive `files.export` as `text/plain`). Sheets are not checked. Note: `fetchDocContent` uses `SUGGESTIONS_INLINE` mode, so the document text includes pending suggestion text — anchor-text matching may false-positive if a suggestion overlaps the anchor region, but the consequence is only a spurious warning.
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
- **`assignedToMe`** — whether the comment is assigned to the current user. Derived from
  the last reply's `assigneeEmailAddress` if any reply has it, otherwise the top-level
  `comment.assigneeEmailAddress` (case-insensitive). Note: the Drive API only populates
  `assigneeEmailAddress` when the assignee is the authenticated user, so reassignment
  away from the current user is not detectable — in practice this means "was ever assigned
  to me" rather than "is currently assigned to me".
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

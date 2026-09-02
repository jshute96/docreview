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
| `readMessageCount` | Docreview | How many of the thread's messages I've read (see [Read Tracking](#read-tracking)) |
| `assignedToMe` | Drive | The comment was assigned to me (derived from comment + reply `assigneeEmailAddress`; see limitation below) |
| `mentionedMe` | Drive | I was @mentioned anywhere in the thread (comment or any reply). Cleared when `assignedToMe` is true (assignment takes precedence) |
| `mentionedMeUnreplied` | Drive | `mentionedMe` is true and there's no reply/resolve by me after the last mention. Cleared when `assignedToMe` is true |
| `suggestionContentHash` | Drive / Gmail / Ext | Content hash of suggestion text/action, used to pair up records created by different sync paths. |
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

### Editing and Deleting from Docreview

Comments and replies the signed-in user wrote can be edited or deleted in place from the
expanded thread, via `/api/docs/[docId]/threads/edit` (Drive's `comments.update`/`delete` and
`replies.update`/`delete`). Drive refuses these on other people's entries, so the menu is only
offered on entries with `fromMe`. Drive independently enforces the same rule.

Deleting the first comment of a thread deletes the whole thread; the `Comment` record is
removed immediately, matching what a later full sync would do. Deleting a reply re-syncs the
thread so `replyCount` and the derived flags follow.

A deleted comment or reply is not removed from Drive outright — it comes back from
`comments.get` with `deleted: true` and its content stripped. `comments.list` omits them
(unless `includeDeleted` is set, which we don't), and Google Docs itself hides them, so the
parsing helpers in `google-drive.ts` treat a `deleted` comment as absent and filter `deleted`
replies out before anything counts or renders them.

#### Keeping a self-edit out of the Inbox

An edit changes the comment's `modifiedTime` in Drive, and `updateExistingComment` normally
treats a changed `driveModifiedAt` as new activity — which for an `ARCHIVED` comment means
`INBOX` and unread. That rule exists for *other people's* activity; your own typo fix shouldn't
resurface your own comment.

So the edit route passes `selfEdited: true` to `syncSingleComment`, which drops **only** the
timestamp test out of `hasNewActivity`:

```ts
const hasNewActivity =
  hasNewReplies ||
  (!existing.resolved && c.resolved) ||
  (existing.resolved && !c.resolved) ||
  (!selfEdited && !datesEqual(existing.driveModifiedAt, c.driveModifiedAt));
```

Every other trigger still counts. The status and `readMessageCount` that `computeCommentStatus`
and `buildCommentUpdate` produce are therefore already correct, and the sync's single
`comment.update` writes them — there is no second write walking a status change back, and no
window in which the comment sits in the wrong state.

Two cases follow from this:

- **You edit, nothing else happened.** `hasNewActivity` is false, so `computeCommentStatus`
  returns `previousStatus` and `readMessageCount` is carried over from the existing record. The
  new `driveModifiedAt` is still stored, so the next full sync compares equal and likewise finds
  no activity — the state holds without needing the flag again.
- **Someone else replies while you're saving.** `hasNewReplies` is true, so `hasNewActivity` is
  true regardless of the flag and the reply is handled exactly as on any other sync: `INBOX`,
  unread, @-mention rules and all. Their activity is never lost to your edit.

The flag reaches `buildCommentUpdate` as well, because without it a self-edit would count as
activity without new replies, which marks the thread's last message unread. Every other caller
passes the timestamp comparison itself, so their behavior is unchanged.

Not covered, deliberately: `driveModifiedAt`, `replyCount`, and the doc's `lastCommentActivity`
all reflect the edit, so the doc still sorts as recently active.

#### Editing is the same plain text as replying

The editor is seeded with Drive's `content` (plain text) and `comments.update` writes plain text
back, exactly like posting a reply. Markup round-trips the way it does in the reply box: bold
text reads as `**bold**` while editing and renders bold again afterwards, because `htmlContent`
is regenerated by Drive from the text we send.

Suggestions can't be edited or deleted — see `docs/suggestions.md`.

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

1. Compare `resolved`, `isReplyAuthor`, `assignedToMe`, `mentionedMe`,
   `mentionedMeUnreplied`, `status`, `driveCreatedAt`, `driveModifiedAt`, and `replyCount`
   against the existing record, along with the `readMessageCount` the read rules produce
   (see [Read Tracking](#read-tracking)). Skip the update if all match.
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

## Read Tracking

Read state is stored per thread as **`readMessageCount`**: how many of the thread's messages
have been read, counting from the start. A thread's messages are the head comment plus its
replies, so a thread with `replyCount` replies has `replyCount + 1` messages, and:

- `readMessageCount = 0` — nothing read.
- `readMessageCount >= replyCount + 1` — fully read.
- Anything between — the messages after `readMessageCount` are unread.

The helpers live in `src/lib/read-state.ts` (`isThreadRead`, `totalMessageCount`,
`initialReadMessageCount`) and are shared by server and client. Always compare with `>=`:
deleting a reply shrinks `replyCount`, so a stored count can exceed the current total.

**Google provides no read signal.** Neither Drive nor the Docs API reports whether a comment
has been seen, and Docreview doesn't try to infer one from the Google Docs UI. This is purely
Docreview-managed state: it means "read *in Docreview*", advanced by your own activity in the
thread and by the Mark read/unread buttons.

### How the count is set

| Situation | Result |
|---|---|
| New thread, first sync | Messages through my last contribution — see below |
| I authored the latest message (the derived `isRead`, see below) | Fully read |
| Someone else replied | **No write.** The preserved count already makes the new replies unread |
| Activity with no new replies (edit, deleted reply, resolve flip) | Last message marked unread |
| No activity | Preserved (clamped down if `replyCount` shrank) |
| "Mark read" button | Fully read, using the `replyCount` the DB knew at click time |
| "Mark unread" button | 0 (whole thread) |

`initialReadMessageCount` seeds a new thread with the messages up through my last contribution,
on the reasoning that writing a message implies having read what came before it. A thread I
acted last on is therefore fully read, one I never posted in is fully unread, and one where
others replied after me lands partially read — my reply followed by two replies I've never
seen seeds as "2 unread".

That "no write when someone else replies" row is what makes manual toggles sticky: nothing
overwrites the count, so a thread you marked unread stays unread even as replies arrive, and a
thread you'd read shows only the new replies as unread.

### Suggestions

`readMessageCount` on a suggestion only gets meaningful values from the Chrome extension, the
only source with per-reply authorship (accept/reject actions count as replies, so the units
match comments). The Docs API never writes `replyCount` or `readMessageCount`; Gmail merges
write `replyCount` only. A suggestion Docreview has only ever seen via the Docs API therefore
sits at `0/1` and reads as unread.

### Gmail raises the total without touching the count

`mergeSuggestionsFromGmail` updates an existing row's `replyCount` (to
`max(notification replies, stored)`) and never writes read state. Because the total is
`replyCount + 1`, a notification about new replies makes a read suggestion show exactly those
new replies as unread, with no read-state write anywhere — the two fields stay consistent by
construction, so this path never has to reason about read state at all.

`mergeCommentsFromGmail` has no such interaction: it only inserts threads Drive couldn't
supply (docs where `comments.list` returns 403) and is a no-op when the row already exists,
so Gmail never revises an existing comment's reply count.

### Not tracked

The count is a position, not a set of message identities, so **deleting a reply below the read
boundary shifts the boundary down with it** and credits one previously-unread message as read.
A thread with 5 replies read up to 2 has 4 unread; delete reply 0 and it has 3. Fixing this
would mean storing per-message IDs, which no sync path provides for replies.

### Display

The comment table's **Unread** column reads "unread / total" — `unreadMessageCount` (total minus
read, clamped at 0) over `totalMessageCount`, both counting the head comment, so the total is one
more than the reply count and an untouched zero-reply thread reads "1 / 1". `CommentRow` draws it
as a fixed-track grid inside one cell (count, slash, total), so the three parts line up down the
table without depending on how the table apportions column widths — a `colSpan` heading over three
real columns was tried first and left the slash drifting away from the number. The column is left-aligned and
carries the same minimum width as the two date columns beside it, so the four headings space
evenly across the row. The count is blank on a fully-read thread, and a read thread with a
single message is left entirely blank rather than showing "/ 1". The column doesn't sort — the
filter bar's Unread toggle covers the same ground, and there's no sensible single order for a
pair of numbers. An expanded thread
marks each unread message with a blue left rail and bold author name, and draws an "N unread"
rule above the first unread message when there is a read part above it to separate from
(`CommentThreadPanel`'s `readMessageCount` prop). The rail is a border and the green "by me"
tint is a background, so a message of yours that was manually marked unread shows both.

Every message in an expanded thread carries a read-point control, revealed on hover at the end
of its author row: a small blue button reading **Mark read** on an unread message and **Mark
unread** on a read one — the same wording as the whole-thread button in the panel footer, since
it does the same thing over a narrower range. Clicking it on an unread message marks that message
and everything above it read (`readMessageCount = index + 1`); clicking it on a read message
makes that message the first unread one (`readMessageCount = index`). The controls appear on the
head comment and the last reply too, so the boundary reaches either end: using it on an
already-read head comment marks the whole thread unread, and on a still-unread last message
marks the whole thread read.
(The other direction on those two messages is unremarkable — it reads just the head comment, or
unreads just the last message.)

Suggestions get the same controls. A suggestion with no Drive thread renders as a single
synthesized message, where the only reachable values are 0 and 1 — both meaningful, and the
Unread column keeps counting against the stored `replyCount` either way. Note that a
suggestion's `replyCount` is a high-water mark (`suggestion-merge.ts` stores
`Math.max(replies.length, stored)`), so it can exceed the messages the panel renders; the
per-message control then can't reach "fully read" from the last visible message, and the
footer's whole-thread button is the way to get there.

The control sends an absolute `readMessageCount` to `PATCH /api/docs/[docId]/comments/[commentId]`,
counted from the thread the panel fetched. The route clamps it to the thread's stored size, so a
stored read count never exceeds the thread it belongs to. Sending it together with `isRead` is
rejected, since both write the same field.

That clamp needs the stored size to be current, and it isn't always: expanding a thread fetches it
live from Drive (`GET .../threads?commentId=`) without writing anything back, so a reply posted
since the last sync shows in the panel while `replyCount` still lags. So before sending a count
past the stored size, the client first syncs that thread (the `POST` refresh, which runs
`syncSingleComment`) and only then writes. The clamp therefore caps against a current count in the
normal case.

A suggestion syncs through the extension instead of Drive, and only when the extension is there
to ask. Either kind can still come back short — the sync can fail, and a suggestion's stored
count can exceed what the panel renders — and the clamp then puts the read point somewhere other
than where the click asked for. The client says so rather than leaving rails that didn't move,
except when the sync itself already reported a failure.

The footer's "Mark read"/"Mark unread" buttons remain whole-thread: read means every known
message, unread resets to 0. Expanding a thread never changes the count. Marking read is an
assertion that you're done with the thread, not that you looked at each message, so it credits
messages you never expanded as read.

The read-point write itself never changes the comment's status — it won't unarchive or re-inbox a
thread, matching the whole-thread buttons. The sync that can precede it is a different matter: it
runs `syncSingleComment`, which applies the usual status rules, so a click that turns up replies
the DB hadn't seen can move the comment to `INBOX` and unarchive its doc. That's the same outcome
any other refresh would produce on finding those replies.

### Folding away read messages

A thread expanded with unread messages hides the middle of its read run, so the new activity is
what you land on. The messages that always stay are the head comment — what everyone is replying
to — and the last read message, so the first unread reply has its antecedent on screen. Anything
between them (indices 1 through `readMessageCount - 2`) is replaced by a grey "N hidden" rule
with a button that reveals them.

Two or more messages in the run always fold — the "N hidden" line costs less space than they do.
A run of exactly one folds only if that message is long: at least `MIN_LINES_TO_HIDE_ONE` (8)
estimated display lines, since folding a one-line reply behind a one-line rule gains nothing.
The estimate wraps the text at roughly 7px per character against the panel's own width (its `p-4`
padding and the replies' `ml-8` indent subtracted), so it's window-width dependent by design: a
narrow window wraps more and buries the unread messages further down. Both the estimate and the
decision live in `src/lib/thread-fold.ts` rather than in the component, so the threshold and the
boundaries are unit-tested.

The width comes from a callback ref that measures and re-observes whenever the node changes —
not an effect, because the panel usually mounts into its "Loading comments..." branch and swaps
to the real one once the fetch lands. Measuring happens before paint, so nothing flashes in and
back out.

Suggestions fold too — it's the same panel — but rarely do: only extension-synced suggestions have
real replies, and a synthesized single-message suggestion fails both conditions. The suggestion
summary in `headerContent` is never folded, since it isn't a message. The fold measures the live
thread and clamps `readMessageCount` to it, so a suggestion's high-water-mark `replyCount` can't
distort it.

**What folds is decided once per open, and after that the fold can only go away.** `CommentRow`
bumps an `expandId` on every expand and the panel re-decides on the first render after it where
the thread and the width measurement are both available; nothing re-decides for the rest of that
open. If any of the folded run has to come back on screen — a "Mark unread" inside it, a deleted
reply, a search that has to show every match — the whole fold is dropped rather than resized.
Showing the run in full is easier to follow than watching "5 hidden" quietly become "2 hidden".

The upshot is that the fold only ever appears as a thread opens. Marking a message read
mid-thread, replying, refreshing in new replies, or clearing the search box can never make a
message that was on screen disappear.

The panel doesn't own the shown/hidden state either: `CommentRow` passes `showReadMessages` and
resets it to false on every expand, so re-opening a row folds again. **Expand all** sets it to
true — "all" means all the way, including on rows that were already open and folded — while a
row click and **Expand unread** leave it false.

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
6. **Existing suggestion with new activity** — the suggestion mirror of comment rules
   2–4: a suggestion moving ARCHIVED → INBOX, a new non-self reply on an already-INBOX
   suggestion, or someone else accepting/rejecting it triggers unarchive. Gated on the
   thread being unread, so my own last action (typing a reply, accepting/rejecting myself)
   won't resurface the doc.

**New suggestion** (not previously in DB):
- **Docs API path**: `status: "INBOX"` when `doc.role === "AUTHOR"`; otherwise `"ARCHIVED"`.
  The Docs API has no participation/mention data, so only doc role is checked.
- **Extension path**: applies comment-like rules — `@-mention → INBOX`, `resolved → ARCHIVED`,
  `doc author or participant → INBOX`, otherwise `ARCHIVED`.
- **Extension enrichment**: when the extension first enriches a Docs API-created suggestion
  (adding the disco ID), both the initial status and `readMessageCount` are re-evaluated with
  the now-available participation data. This corrects cases like "my suggestion on a REVIEWER
  doc" from ARCHIVED to INBOX, and seeds the read count from the per-reply authorship flags.
- **Gmail-first inserts**: always `"INBOX"` (notification = interesting activity).
- Gmail merge promotes `ARCHIVED` suggestions to `INBOX`; `MUTED` stays `MUTED`.
- Extension merge applies activity-based status transitions on existing suggestions
  (same rules as comments: new reply @-mention breaks MUTED, new activity + relevance
  promotes ARCHIVED → INBOX).

**Suggestion read state** (extension merge only — Docs API and Gmail have no authorship data):
- Seeded with `initialReadMessageCount`: messages through my last contribution, where the
  accept/reject action counts as a reply. Mirrors what `deriveCommentFlags` feeds comment sync.
- Preserved across updates when there is no new activity (no new replies, no resolve-state
  change), so manual "mark unread" toggles stick. See [Read Tracking](#read-tracking).
- Doc-level unarchive rules for suggestions mirror comments and are gated on the thread being
  unread:
  (1) transition to INBOX, (2) existing INBOX with new replies (unless I resolved it),
  (3) INBOX resolved by someone else. Rules 2 and 3 additionally require the target
  status to be INBOX — when silent-accept sends a suggestion to ARCHIVED, the doc is
  not resurfaced.

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
- **Unread** — filter by threads with any unread message (`!isThreadRead`)
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

The sortable data columns are Created and Modified — the only two with a meaningful single order. Status (which combines star, Mine/Replied/Assigned/@Mentioned badges, and Resolved/Open state into one column) and Unread don't sort. The Assigned badge is shown in a darker style (amber-600) to stand out.
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
| **Status fields** | `isThreadAuthor`, `isReplyAuthor`, `mentionedMe`, `readMessageCount`, etc. from Drive | Default to `false`/`0` from Docs API; `isThreadAuthor`/`isReplyAuthor`/`mentionedMe`/`readMessageCount` populated by extension merge when available |
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

### Missing disco IDs are transient, never placeholders

Disco IDs are read out of Google's minified Closure listener objects, and the property path
is discovered by diffing two list items. Neither is available until the comments pane has
finished wiring up its click handlers, so a scrape that runs too early can produce list items
whose ID can't be extracted.

**No source may substitute a placeholder value for a missing disco ID.** The ID is the join
key for every downstream lookup — the DB match in the merge paths, `findUnlinkedSuggestionsByHash`,
and `?disco=` navigation — all of which use exact equality. A fabricated value can never match
anything, but it does occupy `googleCommentId`, which permanently excludes the row from the
hash-merge repair path (that query requires `googleCommentId: null`). The real suggestion then
inserts a duplicate row and the two never reconcile.

Instead, each layer drops the item and treats it as a transient failure:

| Layer | Behavior |
|---|---|
| `iterateItems` (`background-injected.js`) | Drops the item, counts it in `missing` |
| `fetchCommentsAndSuggestions` (`background-injected.js`) | Retries the scrape in-page (3 attempts, 200ms apart, bounded by a deadline), then reports `missingIdCount` |
| `getCommentsAndSuggestionsFromDoc` (`bridge-to-extension.ts`) | Passes `missingIdCount` through to the caller |
| `doc-detail.tsx` | Merges what it got, leaves `extensionSuggestionsLoaded` clear, and schedules a re-fetch (3 retries, 2s apart; the budget resets once a scrape comes back complete, so it's per-episode rather than per-page-load) |
| `mergeExtensionSuggestions` | Filters with `isDiscoId()` and reports `skipped` — backstop against a stale extension build |

Three subtleties in that chain:

- **The client can't rely on `docReady` to trigger the retry.** The extension fires
  `docReady` once per doc page load, so when the Google Doc tab was already open before the
  comments page mounted, it has already fired and the handler never runs. Hence the explicit
  timer in `doc-detail.tsx` — without it, the only recovery would be a manual Refresh.
- **The extension's check and the server's `isDiscoId()` are not the same expression**, so a
  suggestion can survive the scrape (not counted in `missingIdCount`) and still be rejected by
  the server. `doc-detail.tsx` therefore treats a non-zero `skipped` in the merge response as a
  partial result too, and retries on that signal as well.
- **A merge that never happened counts as partial.** The client helper returns `null` (not
  `0`) when the POST fails, so a 5xx or network blip can't be read as "nothing was skipped."
  Without that distinction the most likely failure — the whole request failing — would mark
  the load complete and switch off the retry path entirely. The exception is an expired
  token: `apiFetch` throws `ApiAuthError` and the reauth toast has already fired, so that
  case is guarded with `isAuthError` and deliberately does *not* retry.

Merging a partial result is only safe because `mergeExtensionSuggestions` is purely
additive — it never treats "absent from this payload" as resolved or deleted, so a short
batch can't retract anything. Don't add deletion reconciliation there without revisiting
this.

The Gmail paths follow the same rule. `extractDiscoId` is an unvalidated regex capture off the
notification URL, so it can return `""` *or* a non-empty malformed value from a mangled link —
both are rejected by `isDiscoId()`: `comment-merge.ts` skips the thread, `suggestion-merge.ts`
writes `googleCommentId: null` and doesn't use the bad value as a lookup key either.

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
- **Fields used for sync**: `id, resolved, deleted, createdTime, modifiedTime, author(me), assigneeEmailAddress, mentionedEmailAddresses, replies(id, deleted, action, author(me), assigneeEmailAddress, mentionedEmailAddresses)`. `deleted` on both levels is what lets the parsing helpers drop deleted entries (see above); reply `id` is needed to edit or delete a specific reply.
- **Fields used for thread display**: adds `content, htmlContent, quotedFileContent(mimeType, value), author(displayName), replies(content, htmlContent, createdTime, author(displayName))`
- **`htmlContent`**: Read-only field with HTML formatting of comment/reply text (bold, italics, @mention links). The API recommends displaying `htmlContent` over plain `content`. The thread panel renders it via `dangerouslySetInnerHTML`, passing it through `sanitizeHtml()` (`src/lib/sanitize-html.ts`, a DOMPurify wrapper) first — Drive already escapes user text, so this is defense in depth. `quotedFileContent.value` is sanitized the same way.
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
- **`isRead`** — transient, computed per sync, never stored: if `replies.length > 0`,
  `replies[last].author.me === true`; otherwise `comment.author.me === true`. It answers
  "was I the last to act", which sync uses to advance `readMessageCount` and to gate the
  doc-level unarchive rules. Stored read state lives in `readMessageCount` — see
  [Read Tracking](#read-tracking).
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

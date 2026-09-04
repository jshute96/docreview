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
| `replyCount` | Drive | Number of *live* replies to the comment (not counting the original, and not counting deleted ones) |
| `replySlotCount` | Drive | Number of reply *slots*, deleted replies included. Monotonic (see [Read Tracking](#read-tracking)) |
| `readSlotCount` | Docreview | The read boundary, counted in slots (see [Read Tracking](#read-tracking)) |
| `readMessageCount` | Docreview | The same boundary in live messages — a cache the table and filters read (unread is `replyCount + 1` minus this) |
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

When a whole comment *thread* is deleted in Google Docs, Drive keeps a tombstone for it, but
it's an empty one: the head comment's content and author are stripped, and deleting a head
takes every reply with it (verified against real docs — no deleted thread had a surviving live
reply). Sync therefore skips any comment with `deleted: true` and treats it as absent. Since we
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

A deleted comment or reply is not removed from Drive outright — it leaves a tombstone. Both
`comments.list` and `comments.get` omit tombstones **unless `includeDeleted: true` is set**, and
Docreview now sets it on both. A tombstone keeps only `id`, `createdTime`, `modifiedTime` and
`deleted: true` — the content **and the author** are gone, so there is nothing to draw and no
way to attribute it. Google Docs hides them and so does Docreview: deleted threads are skipped
outright, and deleted replies are kept only as positions, filtered out before anything is
rendered (`liveThreadReplies`). What those positions are for is [Read Tracking](#read-tracking).

#### Keeping a self-edit out of the Inbox

An edit changes the comment's `modifiedTime` in Drive, and `updateExistingComment` normally
treats a changed `driveModifiedAt` as new activity — which for an `ARCHIVED` comment means
`INBOX` and unread. That rule exists for *other people's* activity; your own typo fix shouldn't
resurface your own comment.

So the edit route passes `selfEdited: true` to `syncSingleComment`, which drops **only** the
timestamp test out of `hasNewActivity`:

```ts
const hasNewActivity =
  !deletionOnly &&
  (hasNewLiveReplies ||
    (!existing.resolved && c.resolved) ||
    (existing.resolved && !c.resolved) ||
    (!selfEdited && !datesEqual(existing.driveModifiedAt, c.driveModifiedAt)));
```

Every other trigger still counts. The status and `readSlotCount` that `computeCommentStatus`
and `buildCommentUpdate` produce are therefore already correct, and the sync's single
`comment.update` writes them — there is no second write walking a status change back, and no
window in which the comment sits in the wrong state.

Two cases follow from this:

- **You edit, nothing else happened.** `hasNewActivity` is false, so `computeCommentStatus`
  returns `previousStatus` and `readSlotCount` is carried over from the existing record. The
  new `driveModifiedAt` is still stored, so the next full sync compares equal and likewise finds
  no activity — the state holds without needing the flag again.
- **Someone else replies while you're saving.** `hasNewLiveReplies` is true, so `hasNewActivity`
  is true regardless of the flag and the reply is handled exactly as on any other sync: `INBOX`,
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
`fetchCommentData()` reports that 403 back as `permissionDenied` — the same flag
name the comment sync result uses — so the comments page can say "Comments not
visible on this document." rather than its ordinary empty state. That message
covers both shapes this takes: the doc-level empty state when Gmail hasn't
supplied any rows, and the thread panel of a Gmail-sourced row that has no Drive
thread behind it (see `docs/api-routes.md`).

Each comment is keyed by `discussionId` (the `disco=` URL parameter). Duplicate
detection uses `findFirst` by docId + googleCommentId. Fields are populated from
the email: author, timestamp, content (text or suggestion placeholder), reply count.
Gmail never reports deleted replies, so slot space and render space coincide and both
count columns get the same value; both read counts stay at their default of 0, leaving
the thread unread. Rows are insert-only — an existing `discussionId` is skipped, so this
path never revises a count or a read boundary.
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
   against the existing record, along with the `readSlotCount` the read rules produce
   (see [Read Tracking](#read-tracking)). Skip the update if all match.
2. If a **new reply @-mentions or assigns me** → `INBOX` (overrides all other rules,
   including MUTED).
3. If `resolved = true` AND I was the one who resolved it → set status to `ARCHIVED`.
4. Otherwise, if there is **new activity** (new *live* replies, thread re-opened, or
   modification detected via `driveModifiedAt` — but see "Deletions aren't activity" below),
   apply relevance-based rules:
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

#### Deletions aren't activity

`updateExistingComment` computes `deletionOnly` — something was deleted this sync (the live
reply count dropped while the slot count held, or a slot arrived already dead) and neither a
live reply nor a resolve flip arrived with it — and suppresses `hasNewActivity` entirely when it
holds. A pure deletion therefore doesn't mark the thread unread, doesn't move it to `INBOX`, and
doesn't unarchive the doc.

The slot-count condition on the live-count drop matters: a real deletion leaves a tombstone, so it
never lowers the slot count. A *stored* count that was simply too high does — a Gmail-created row
seeds both counts from the notification's reply list (`comment-merge.ts`), which can overshoot
what Drive later reports — and that first Drive sync of the thread is real activity, not a
deletion.

The rule it's enforcing: **if nothing would show as unread, the comment shouldn't move to
Inbox; if no comment moves to Inbox, the doc shouldn't either.** Drive's thread-level
`modifiedTime` moves for a deletion just as it does for a reply, so without this a doc would
land back in Inbox with nothing on it that explains the trip — and a reply posted and deleted
between two syncs would do the same, arriving as a brand-new tombstone slot that looks like a
new reply.

Deciding this here, rather than in `nextReadSlotCount`, is what makes the invariant hold: one
flag drives the read boundary, the comment's status, and the doc unarchive together, so they
can't disagree. All three doc-unarchive rules are covered by it — rule 1 needs a status
transition (which needs activity), rule 2 needs `hasNewLiveReplies`, and rule 3 needs a resolve,
which is exempt from the suppression precisely so it keeps working.

Still activity, deliberately:

- **A resolve or unresolve flip.** Exempt even when a deletion lands in the same window. The new
  `resolved` value is committed either way, so a sync that dropped the flip would be the last
  chance to see it — re-opening an archived thread would leave it archived forever. It also
  resurfaces the thread's last live message as unread, so the doc has something to show.
- **An edit** on its own (it resurfaces the last live message as unread too).
- **A deletion alongside a live new reply** — the reply is the activity.

Swallowed, accepted: an edit landing in the same window as a deletion. Drive reports one
thread-level `modifiedTime` and no per-message detail, so the two are indistinguishable, and
silently marking a message unread is the worse failure. Unlike a resolve flip, an edit leaves no
state we'd lose track of.

The effect: threads you close yourself get archived quietly. Manual archiving is preserved.
Activity only surfaces in Inbox when it's relevant to you — not all activity on every thread.

---

## Read Tracking

Read state is a **boundary**, not a set of message identities, and it is counted in *slot
space*. Two numberings matter:

- **Slot space** — the head comment plus every reply slot Drive has ever returned, tombstones
  included. Slot positions never move and the slot count only ever grows, because a deleted
  reply keeps its place in Drive's response (`deleted: true`, content and author stripped).
  `readSlotCount` lives here: 0 = nothing read, `replySlotCount + 1` = fully read.
- **Render space** — the head comment plus the *live* replies. This is what the thread panel
  draws and what the docs table counts.

Counting the boundary in slot space is what keeps it still. When the boundary was a live-message
position, deleting a reply below it shifted every later message down one and silently credited
an unread message as read — a thread with 5 replies read up to 2 had 4 unread, and deleting
reply 0 left it with 3. Tombstones hold those positions open, so that no longer happens.

Because tombstones keep their order, the read messages are still a **prefix** of the rendered
ones, so one number converts between the spaces. The helpers live in `src/lib/read-state.ts`
(`renderReadCount`, `slotBoundaryFor`, `unreadMessageCount`, `isThreadRead`, `totalMessageCount`,
`initialReadSlotCount`) and are shared by server and client. `CommentRow` is the only place in
the client that converts — in on the way to the panel, back out when a read-point control
writes — so `CommentThreadPanel` and `thread-fold.ts` do their index arithmetic entirely in
render space and never learn that slots exist.

Sources with no tombstone concept — extension-scraped suggestions, threads synthesized from
Gmail notifications — have no deleted slots, so the two spaces coincide and every conversion is
the identity (`noTombstones`).

The boundary is still clamped to the current slot total. Slot counts are monotonic in every
case Drive documents, but Google guarantees no retention period for tombstones; if they were
ever purged, the clamp is what stops leftover read credit swallowing the next real reply.

**`readMessageCount` caches the boundary in render space.** The docs table and the Unread
filter need it without fetching the thread, and it can't be derived from the stored counts
alone — it depends on which slots *below* the boundary are deleted. So whichever writer moves
the boundary writes both numbers: sync computes it from the real slot array, and the PATCH
route takes it from the client, which converted the position it drew.

Caching the **read** count rather than an unread one matters for two reasons. Its zero value
means "nothing read", so a row created without thinking about read state is correctly fully
unread — the opposite convention would make every new row silently look read. And it doesn't
move when replies arrive: `renderReadCount` depends only on slots *below* the boundary, so
appending replies raises the derived unread with no write anywhere. Only a boundary move or a
deletion below the boundary changes it.

Deleting a read reply is the case worth tracing: `readMessageCount` drops by one because that
message no longer renders, and `replyCount` drops by one alongside it, so
`replyCount + 1 - readMessageCount` is unchanged. The unread count doesn't move, which is the
whole point.

**Google provides no read signal.** Neither Drive nor the Docs API reports whether a comment
has been seen, and Docreview doesn't try to infer one from the Google Docs UI. This is purely
Docreview-managed state: it means "read *in Docreview*", advanced by your own activity in the
thread and by the Mark read/unread buttons.

### How the count is set

| Situation | Result |
|---|---|
| New thread, first sync | Slots through my last contribution — see below |
| I authored the latest message (the derived `isRead`, see below) | Fully read |
| Someone else replied | **No write.** The preserved boundary already makes the new replies unread |
| A message was deleted, and nothing live arrived | Preserved — a deletion isn't activity at all (see ["Deletions aren't activity"](#deletions-arent-activity)), so this lands on the "no activity" rule |
| Activity with no new slots (edit, resolve flip) | Last *live* message marked unread |
| No activity | Preserved (clamped to the slot total) |
| "Mark read" button | Fully read, using the `replySlotCount` the DB knew at click time |
| "Mark unread" button | 0 (whole thread) |

New replies are detected as `replySlotCount > existing.replySlotCount`, and the "which replies
are new" slice is `.slice(existing.replySlotCount)` over slot-indexed flag arrays. Both were
previously counted in live replies, which had a false negative: a delete and a reply landing in
the same sync window left the live count unchanged, so the new reply was never seen at all — no
Inbox move, no unread, no @-mention pickup. Slot counts only grow, so that can't happen. A
tombstone contributes `false` to every flag array (Drive strips its author and mentions), which
is also what you want: a message that no longer exists shouldn't ping anyone, and the
"someone else replied" test explicitly skips tombstone slots so an arrived-already-deleted slot
isn't mistaken for a stranger's reply.

Deletion gets its own row because the generic "activity we can't localize" rule was wrong for
it: deleting the one unread reply left the message *before* it unread, so a thread whose only
unread content had just been removed still showed 1 unread and couldn't be cleared. A deletion
is fully accounted for by itself, so the boundary is carried forward and the surviving messages
keep exactly the read state they had. It's detected as the live reply count dropping while the
slot count holds. The cost is that an edit landing in the same sync window as a deletion is
missed — Drive reports one thread-level `modifiedTime` and no per-message detail, so the two
are indistinguishable.

`initialReadSlotCount` seeds a new thread with the slots up through my last contribution,
on the reasoning that writing a message implies having read what came before it. A thread I
acted last on is therefore fully read, one I never posted in is fully unread, and one where
others replied after me lands partially read — my reply followed by two replies I've never
seen seeds as "2 unread".

That "no write when someone else replies" row is what makes manual toggles sticky: nothing
overwrites the count, so a thread you marked unread stays unread even as replies arrive, and a
thread you'd read shows only the new replies as unread.

### Suggestions

`readSlotCount` on a suggestion only gets meaningful values from the Chrome extension, the
only source with per-reply authorship (accept/reject actions count as replies, so the units
match comments). The Docs API never writes `replyCount` or `readSlotCount`; Gmail merges
write the reply counts and the unread cache only. A suggestion Docreview has only ever seen via the Docs API therefore
sits at `0/1` and reads as unread.

### Gmail raises the total without moving the boundary

`mergeSuggestionsFromGmail` updates an existing row's `replyCount` (to
`max(notification replies, stored)`) and never moves `readSlotCount`. Leaving the boundary
alone is exactly what makes a notification about new replies show those replies as unread on
an otherwise-read suggestion.

It writes no read state at all. Because the stored count is a *read* count, raising the total
is by itself exactly what makes the new replies unread — the two fields stay consistent by
construction, so this path never has to reason about read state.

`replySlotCount` takes a high-water mark too, **against itself** rather than against
`replyCount`. A notification lists the messages Gmail shows, and Gmail never shows deleted
ones, so its count is a live count — but against the slot column it's still a valid *lower
bound*: seeing N live replies proves the thread has at least N slots.

Both parts of that matter. Maxing against `replyCount` instead would write a live count into
the slot column and *lower* it on any thread with a tombstone, and the next Drive sync would
then see the true slot count exceed the stored one and read a long-deleted reply as brand-new
activity. Not writing it at all is also wrong, in a subtler way: the column would lag behind
replies Gmail already told us about, and the next Drive sync would count those same replies as
new a second time — marking them unread again after the user had already read them off the
Gmail bump.

The bound is loose on a thread with tombstones, since Gmail can't see them, so the column can
still lag there. That only errs low, which over-reports new replies later and never hides one —
the same safe direction the migration relies on. The two maxes also preserve the
live-≤-slots ordering: both take the max against the same N, and `replySlotCount` starts at or
above `replyCount`.

The extension merge (`buildExtensionSuggestionUpdate`) takes the same max for the same
reason: it scrapes the rendered thread, which hides deleted replies, so its count is a live
one too. Only `replySlotCount` is guarded that way -- `replyCount` is a plain overwrite,
since it is meant to track what the thread currently draws.

`mergeCommentsFromGmail` has no such interaction: it only inserts threads Drive couldn't
supply (docs where `comments.list` returns 403) and is a no-op when the row already exists,
so Gmail never revises an existing comment's reply count. Inserted rows start fully unread.

### Display

The comment table's **Unread** column reads "unread / total" — `unreadMessageCount`
(`totalMessageCount` minus the stored `readMessageCount`, clamped at 0) over
`totalMessageCount`, both counting the head comment and both counting live messages only,
so the total is one more than the live reply count and an untouched zero-reply thread reads "1 / 1". `CommentRow` draws it
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
(`CommentThreadPanel`'s `readMessageCount` prop — the stored cache is already render-space, so
it passes straight through; only the write path converts, back into slots). The rail is a border and the green "by me"
tint is a background, so a message of yours that was manually marked unread shows both.

Every message in an expanded thread carries a read-point control, revealed on hover at the end
of its author row: a small blue button reading **Mark read** on an unread message and **Mark
unread** on a read one — the same wording as the whole-thread button in the panel footer, since
it does the same thing over a narrower range. Clicking it on an unread message marks that message
and everything above it read (render count = `index + 1`); clicking it on a read message
makes that message the first unread one (render count = `index`). `CommentRow` converts that
render position to a slot boundary before sending it. The controls appear on the
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

The control sends an absolute `readSlotCount` — converted from the position the panel drew,
using the tombstones in the thread it fetched — to `PATCH /api/docs/[docId]/comments/[commentId]`,
paired with that position itself as `readMessageCount`. The two must travel together: they are
the same boundary in the two spaces, and the route can't convert between them without the
thread's tombstones. The route clamps the boundary to the thread's stored slot size, so a
stored boundary never exceeds the thread it belongs to; the clamp only fires at that total, so
when it does the render-space twin becomes the full live total. Sending a boundary together
with `isRead` is rejected, since both write the same field.

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
between them (render indices 1 through `readMessageCount - 2`) is replaced by a grey "N hidden" rule
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
thread and clamps the render-space read count to it, so a suggestion's high-water-mark `replyCount` can't
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
   should see. This fires on the *transition* only (the sync that first sees `resolved`
   flip to true), not on the standing resolved state: a thread that stays INBOX and
   resolved would otherwise re-unarchive its doc on every sync, and the doc could never
   be archived.
5. **New suggestion with INBOX status** — a new suggestion (from Docs API, Gmail, or
   extension) that gets INBOX status triggers unarchive.
6. **Existing suggestion with new activity** — the suggestion mirror of comment rules
   2–4: a suggestion moving ARCHIVED → INBOX, a new non-self reply on an already-INBOX
   suggestion, or someone else accepting/rejecting it for the first time triggers unarchive.
   Like rule 4 above, that last one fires on the transition, not the standing state. Gated on the
   thread being unread, so my own last action (typing a reply, accepting/rejecting myself)
   won't resurface the doc.

**New suggestion** (not previously in DB):
- **Docs API path**: `status: "INBOX"` when `doc.role === "AUTHOR"`; otherwise `"ARCHIVED"`.
  The Docs API has no participation/mention data, so only doc role is checked.
- **Extension path**: applies comment-like rules — `@-mention → INBOX`, `resolved → ARCHIVED`,
  `doc author or participant → INBOX`, otherwise `ARCHIVED`.
- **Extension enrichment**: when the extension first enriches a Docs API-created suggestion
  (adding the disco ID), both the initial status and `readSlotCount` are re-evaluated with
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
  (3) INBOX newly resolved by someone else. Rules 2 and 3 additionally require the target
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
| **Status fields** | `isThreadAuthor`, `isReplyAuthor`, `mentionedMe`, `readSlotCount`, etc. from Drive | Default to `false`/`0` from Docs API; `isThreadAuthor`/`isReplyAuthor`/`mentionedMe`/`readSlotCount` populated by extension merge when available |
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
- **Fields used for sync**: `id, resolved, deleted, createdTime, modifiedTime, author(me), assigneeEmailAddress, mentionedEmailAddresses, replies(id, deleted, action, author(me), assigneeEmailAddress, mentionedEmailAddresses)`. `deleted` on both levels is what separates tombstones from live entries (see above); reply `id` is needed to edit or delete a specific reply.
- **`includeDeleted`**: set to `true` on both `comments.list` and `comments.get`. One flag covers both levels — without it Drive returns neither deleted threads nor deleted replies, and with it both come back. Deleted threads are skipped by sync; deleted replies are kept as positions for read tracking. Tombstones retain only `id`, `createdTime`, `modifiedTime` and `deleted`; content, author, `resolved` and `quotedFileContent` are all stripped. They persist indefinitely in practice (entries six months old still come back), though Google documents no retention guarantee.
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
  "was I the last to act", which sync uses to advance `readSlotCount` and to gate the
  doc-level unarchive rules. Stored read state lives in `readSlotCount` — see
  [Read Tracking](#read-tracking).
- **`replyCount`** — the number of *live* replies to the original comment, including resolve
  actions. No extra API call; derived from the already-fetched replies.
- **`replySlotCount`** — `replies.length`, tombstones included, and `replyDeleted` the per-slot
  flags. Drive has no reply-count field of its own, so both come free from the array we already
  fetch. Authorship-derived flags (`isThreadAuthor`, `isReplyAuthor`, `iResolvedIt`, `isRead`)
  are computed over the *live* replies, since a tombstone carries no author.
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

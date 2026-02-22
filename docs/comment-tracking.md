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
| `isMine` | Drive | I created the original comment |
| `iParticipated` | Drive | I replied to this thread (non-resolve reply) |
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

## Status on Subsequent Syncs

The Drive API's `startModifiedTime` parameter returns only comments modified since the last
sync. If a comment is returned, something changed (a reply was added, it was resolved or
re-opened).

**MUTED**: If status is `MUTED`, it is left unchanged. Muted threads stay hidden regardless
of new Drive activity. Drive-side fields (`resolved`, `iParticipated`, `driveCreatedAt`,
`driveModifiedAt`, `replyCount`) are still updated so the detail page reflects current state.

**For all other statuses**, apply this logic:

1. Update `resolved`, `iParticipated`, `driveModifiedAt`, and `replyCount` from Drive data.
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

## Detail Page Filters

The doc detail page provides three ways to narrow the comment table:

**Show mode** (mutually exclusive):
- **Active** — only comments with `status = ACTIVE` (default)
- **Open** — all unresolved comments regardless of status
- **All** — every comment, including archived and muted

**Toggle filters** (AND-combined with show mode):
- **My threads** — keep only `isMine || iParticipated`
- **My comments** — keep only `isMine`

All five data columns (Created, Modified, Responses, Mine, Replied, Status) are sortable.
Modified shows "—" when it equals Created (i.e., no replies have been added).

---

## Suggestions

Suggestions (tracked changes) are a separate comment type (`type: "SUGGESTION"`) and have
their own sync logic. They are displayed in the comment table and can be filtered with the
**Suggestions** toggle. For full details, see [`suggestions.md`](./suggestions.md).

---

## Drive API Notes

- **Endpoint**: `GET /drive/v3/files/{fileId}/comments`
- **`fields` is mandatory** — Drive returns nothing without it.
- **Fields used**: `id, resolved, createdTime, modifiedTime, author(me), replies(action, author(me))`
- **`startModifiedTime`**: RFC 3339 timestamp; filters to comments modified after this time.
  Used to make incremental syncs cheap — returns empty if nothing changed.
- **File `modifiedTime` does NOT update when comments change.** This is why we cannot use the
  file's modification time as a sync gate. Instead, `commentsLastSyncedAt` is stored per doc
  and passed as `startModifiedTime` on each sync.
- Scope: `drive.readonly` is sufficient (already configured).
- Pagination: `comments.list` returns `nextPageToken`; always paginate to completion.

---

## "I Participated" and Reply Count Detection

Each comment object includes author info and a list of replies. The replies array is fetched
once and used for three derived fields:

- **`isMine`** — `comment.author.me === true`: I created this thread.
- **`iParticipated`** — at least one reply has `author.me === true` AND `action` is not
  `"resolve"` (i.e., a substantive reply, not just a resolve action).
- **`iResolvedIt`** — find the last reply where `action === "resolve"`; true if
  `author.me === true`.
- **`replyCount`** — `replies.length`: total number of replies to the original comment,
  including resolve actions. No extra API call; derived from the already-fetched replies.

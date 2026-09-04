# Inbox states and state changes

## Overview

The "Inbox" has the set of items the user is actively working on or waiting for completion.
It's the set of items the user is currently following or paying attention.

There's a Inbox for documents.

Each document also has its own Inbox for comments on that document.

There are three main states for an item:

1. **In inbox** - item being followed or worked on
2. **Archived** - default state for item not in inbox.  It will come back into Inbox if something happens that should raise attention.
3. **Muted** - item is silenced.  It won't come back into the inbox (except in some specific cases).

**Author state**: Documents have a `Author` state.  This indicates this is "my document".  It's filled by default based
on whether I actually created the document, but I can add or remove that manually, to indicate I am a co-author or that
I am not longer interested in acting like the author.

## Rules for state changes

* For newly added documents (including those that were **Deleted & re-added**):
  1. The doc starts as **Archived** (even if I am the Author, and even if discovered via a Gmail notification).
     * This avoids noise from old documents resurfacing with no current attention-worthy activity (e.g., a Gmail notification that turns out to be only resolves on old comments).
  2. The doc is promoted to **Inbox** if any of the following happen during the same refresh:
     * A sharing email arrived for the doc (share-note branch — sharing is treated as a strong attention signal).
     * The subsequent comment sync produces `shouldUnarchive` for relevant new activity (see "Smart Unarchive" below).
     * A Gmail-merged comment or suggestion is inserted (e.g., notifications for docs the user lacks comment access to).

* For new suggestions:
  1. If I am Author on the doc, new suggestions go to Inbox.
  2. Otherwise (Reviewer), new suggestions start as Archived.
  3. Exception: if a Gmail notification arrives for the suggestion, it goes to Inbox
     (notification = interesting activity), unless it was Muted.
  4. Exception: when the extension enriches a suggestion with participation data
     (e.g., I created it), the comment rules below are applied to correct the
     initial status.

* For suggestion resolution (accepted/rejected):
  1. If I accepted/rejected someone else's suggestion, it goes to Archived.
  2. If it's my suggestion and it was accepted with no discussion replies, it goes
     to Archived (nothing interesting to see — a silent accept).
  3. If it's my suggestion and it was rejected, no status change (may need follow-up).
  4. If it's my suggestion and it had discussion replies, no status change regardless
     of accept/reject (there was a conversation worth reviewing).

* For new comments, and new replies on a comment (First matching rule wins):
  1. If I resolved a comment that was in Inbox, it goes to Archived.
  2. If a new comment or reply includes an @-mention of me or assigns it to me, it goes to Inbox. 
     * This is the only case when a comment moves out of Muted state.
  3. If the comment thread is Muted, no state change.
  4. If I was previously mentioned or assigned anywhere in the thread and there is new activity, it goes to Inbox.
  5. If I am Author on the doc, all new comments and replies go to Inbox
  6. If I started the comment thread, it goes to Inbox (on initial creation, and if anyone else replies or resolves it)
     * If I reply on a comment thread I started, that doesn't go to Inbox.
  7. If I replied, on a thread I did not start, it goes to Inbox.

## Smart Unarchive

These comment changes trigger moving the document to Inbox:
  1. When a comment gets created in Inbox or moves to Inbox (for any reason, including if I unarchive it)
  2. When a comment in Inbox has any new replies added
  3. When a comment in Inbox gets resolved, but not by me
     * This overrides other rules.  If the comment is resolved and I resolved it, the comment becomes Archived, and this comment doesn't
       trigger moving the document to Inbox.
     * The three trigger rules above all describe *changes*, this one included: it's the sync that first sees the resolve that
       triggers unarchive, not every later sync that finds the comment still resolved.  Otherwise a document
       with a thread someone else resolved could never stay archived.
  4. Exception: comments in **read** state (where I'm the last commenter) never trigger unarchive.
     My own activity shouldn't resurface an archived document, regardless of whether I'm Author or Reviewer.

The same three unarchive rules apply to suggestions when the Chrome extension
provides reply-authorship data (accept/reject counts as a reply, and the user's
`isMine` flag on the last reply marks the thread read). Without the extension, suggestion
unarchive falls back to "new suggestion on my own doc" since the Docs API and
Gmail merge paths can't identify the authors.

---

## Deferred / Not Yet Implemented

The following rules from this spec are not yet implemented:

- **Document-level MUTED state**: No rules are defined yet for how document MUTED state
  should interact with comment state changes. Currently only comment-level MUTED is
  implemented.

- **Shared-with-me detection**: The Drive API's `sharedWithMe` is only available
  as a query filter on `files.list`, not as a response field on any endpoint. Shared-with-me
  docs are detected via Gmail notifications (gmail-refresh), which adds them to the DB
  (bypassing the not-author skip) but starts them as ARCHIVED. They move to INBOX only if a
  sharing email is parsed for them or comment sync surfaces relevant activity. Drive-based
  refresh/load cannot determine sharing status, so non-AUTHOR docs discovered that way are
  skipped entirely.

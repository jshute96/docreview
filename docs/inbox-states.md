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
  1. If discovered via Gmail (which implies a "shared with me" or comment notification), it goes in Inbox.
  2. Otherwise, it starts as **Archived** (even if I am the Author).
     * This avoids noise from the Drive changes feed resurfacing old documents with no new activity.
     * The subsequent comment sync in the same refresh may move it to Inbox if it has relevant unresolved activity (see "Smart Unarchive" below).

* For new suggestions:
  1. If I am Author on the doc, new suggestions go to Inbox.
  2. Otherwise (Reviewer), new suggestions start as Archived.
  3. Exception: if a Gmail notification arrives for the suggestion, it goes to Inbox
     (notification = interesting activity), unless it was Muted.

* For new comments, and new replies on a comment (First matching rule wins):
  1. If I resolved a comment that was in Inbox, it goes to Archived.
  2. If a new comment or reply includes an @-mention of me, it goes to Inbox. 
     * This is the only case when a comment moves out of Muted state.
  3. If the comment thread is Muted, no state change.
  3. If I am Author on the doc, all new comments and replies go to Inbox
  4. If I started the comment thread, it goes to Inbox (on initial creation, and if anyone else replies or resolves it)
     * If I reply on a comment thread I started, that doesn't go to Inbox.
  5. If I replied, on a thread I did not start, it goes to Inbox.

## Smart Unarchive

These comment changes trigger moving the document to Inbox:
  1. When a comment gets created in Inbox or moves to Inbox (for any reason, including if I unarchive it)
  2. When a comment in Inbox has any new replies added
  3. When a comment in Inbox gets resolved, but not by me
     * This overrides other rules.  If the comment is resolved and I resolved it, the comment becomes Archived, and this comment doesn't
       trigger moving the document to Inbox.
  4. Exception: if the document is Archived and the only new comment activity is resolutions (no new
     comments, no new non-resolve replies), the document stays Archived.  This prevents resolved
     threads from resurfacing a document you've already dismissed.
  5. Exception: comments in **read** state (where I'm the last commenter) never trigger unarchive.
     My own activity shouldn't resurface an archived document, regardless of whether I'm Author or Reviewer.

---

## Deferred / Not Yet Implemented

The following rules from this spec are not yet implemented:

- **Document-level MUTED state**: No rules are defined yet for how document MUTED state
  should interact with comment state changes. Currently only comment-level MUTED is
  implemented.

- **Shared-with-me detection** (rule 2): The Drive API's `sharedWithMe` is only available
  as a query filter on `files.list`, not as a response field on any endpoint. Shared-with-me
  docs are currently detected via Gmail notifications (gmail-refresh), which sets them to
  INBOX. Drive-based refresh/load cannot determine sharing status, so non-AUTHOR docs
  discovered that way start as ARCHIVED.

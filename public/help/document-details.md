Click any document in the list to open its details page. This shows the document's metadata and all its comment threads and suggestions.

## Header

The top of the page shows the document's metadata: title, role, status, star, labels, notes, owner, and modification dates. You can edit these from the menu (pencil icon) or toggle status and star directly.

The menu also provides:
- **Untrack this doc** -- Remove the document from Docreview entirely.
- **Delete & re-add** -- Remove and re-import the document for a fresh start.

## Show modes

Three buttons control which comments are visible:

- **Inbox** -- Only comment threads with Inbox status. This is your default working view.
- **Open** -- All unresolved comment threads regardless of status. Useful for seeing everything that's still active.
- **All** -- Every comment thread including archived and muted ones.

## Comment filters

Below the show mode buttons, badge filters let you narrow the list further. Each is a tri-state toggle (off / include / exclude):

- **Mine** -- Threads you started.
- **Replied** -- Threads you've replied in.
- **Assigned** -- Comments assigned to you (only shown if any exist).
- **@Mentioned** -- Threads where you were @mentioned (only shown if any exist).
- **Resolved** -- Filter by resolved/unresolved state.
- **Unread** -- Comments where someone else acted last.
- **Starred** -- Comment-level stars.
- **Suggestions** -- Tracked changes from Google Docs suggestion mode.

## Search

Type in the search box to filter comments by content. Search matches against comment text, reply text, and suggestion content. Matching text is highlighted in the results. Search supports regular expressions.

## Comment table

Each row shows:
- **Status badges** -- Star, Mine/Replied, Assigned/@Mentioned indicators.
- **Preview** -- First line of the comment with the author name.
- **Created** -- When the thread was started.
- **Modified** -- When the last reply was added ("--" if no replies).
- **Responses** -- Number of replies in the thread.

### Row highlighting

Like the document list, comment rows are highlighted for urgency:
- **Red background** -- Assigned to you, unresolved, and in Inbox.
- **Amber background** -- Unreplied @mention, unread, unresolved, and in Inbox.

## Expanding threads

Click a comment row to expand it and see the full thread. The expanded view shows:

- The original comment text with the quoted document text it refers to.
- All replies in chronological order.
- A **reply textarea** -- type a response and press Enter (or click Send) to reply.
- A **Resolve/Reopen button** to change the thread's resolved state.
- Status controls to move the thread between Inbox, Archived, and Muted.
- A link to **open the comment in Google Docs**, which navigates directly to the commented text.

All threads are pre-fetched when the page loads, so expanding a comment is instant.

## Suggestions

Suggestions (tracked changes) appear in the same table as comments. They show the proposed insertion, deletion, or edit text. Suggestions have some limitations compared to comments:

- You can't reply to suggestions or navigate to them in the document.
- Creation and modification dates are approximate.
- The "Mine" and "Replied" filters don't apply to suggestions.

You can still archive, mute, star, and filter suggestions like regular comments.

## Bulk actions

The toolbar provides bulk operations:

- **Expand all unread** -- Opens all comment threads that have unread activity.
- **Collapse all** -- Closes all expanded threads.

## Sort behavior

Comments are sorted by the column you select. When you interact with a single comment (reply, resolve, change status), the sort order is temporarily frozen to prevent the row from jumping to a new position. Click any column header to re-sort.

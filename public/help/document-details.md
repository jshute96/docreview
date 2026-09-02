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
- **Unread** -- Comments with messages you have not read yet (usually because someone else commented last).
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
- **Unread** -- Number of messages in the thread you haven't read, counting the original comment (so an unread comment with no replies shows 1). Empty when the whole thread is read.

### Row highlighting

Like the document list, comment rows are highlighted for urgency:
- **Red background** -- Assigned to you, unresolved, and in Inbox.
- **Amber background** -- Unreplied @mention, unread, unresolved, and in Inbox.

## Expanding threads

Click a comment row to expand it and see the full thread. The expanded view shows:

- The original comment text with the quoted document text it refers to.
- All replies in chronological order. Unread messages have a blue bar on their left edge and a bold author name, and an "N unread" line separates them from the messages above that you've already read.
- Hover over any message to reveal a small blue **Mark read** or **Mark unread** button at the end of its author line, which moves the read/unread boundary to that message. It does the same job as the Mark read/unread button below the thread, but over a narrower range: on an unread message it marks that message and everything above it read; on a message you've already read it marks that message and everything below it unread. So using it on a first message you have already read marks the whole thread unread, and using it on a last message you have not read yet marks the whole thread read.
- A **reply textarea** -- type a response and press Enter (or click Send) to reply.
- A **Resolve/Reopen button** to change the thread's resolved state.
- A **menu button** next to your name on comments and replies you wrote, with **Edit** and **Delete**. Edit replaces the text with a box; Save writes the change to the document and the text only reappears once the save succeeds, so a failure leaves your text where you can fix it. Delete asks for confirmation first — deleting a reply removes just that reply, and deleting the first comment of a thread removes the whole thread, including everyone's replies. Both are permanent. The edit box works the same way as the reply box: you see and type plain text, and formatting like `**bold**` renders once saved.
- Status controls to move the thread between Inbox, Archived, and Muted.
- A link to **open the comment in Google Docs** (or Sheets/Slides), which navigates directly to the commented text.

All threads are pre-fetched when the page loads, so expanding a comment is instant.

## Suggestions

Suggestions (tracked changes) appear in the same table as comments. They show the proposed insertion, deletion, or edit text. Suggestions have some limitations compared to comments:

- You can't reply to suggestions directly from Docreview.
- You can't edit or delete a suggestion from Docreview — Google's API doesn't offer it.
- Creation and modification dates are approximate.
- The "Mine" and "Replied" filters don't apply to suggestions.

When the Chrome extension is active and a doc tab is open, you can **Refresh** a suggestion to re-read its current state from the document. The Refresh button is greyed out when the extension isn't available or the suggestion doesn't have a disco ID for navigation.

You can still archive, mute, star, and filter suggestions like regular comments.

## Bulk actions

The toolbar provides bulk operations:

- **Expand all unread** -- Opens all comment threads that have unread activity.
- **Collapse all** -- Closes all expanded threads.

## Sort behavior

Comments are sorted by the column you select. When you interact with a single comment (reply, resolve, change status), the sort order is temporarily frozen to prevent the row from jumping to a new position. Click any column header to re-sort.

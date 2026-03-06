P0:

P1:
* handle gmail notifications
  * share request emails - from me, to me
  * I shared with you emails
* refine gmail flows
* Remember state/tag for @mentioned on comment, with mine/replied and resolved
* More decoration - favicon.
* Refresh selected docs
* Cancel API requests and other work on tab close?

Easy:
* scroll bars for lots of docs
* Button for search in Drive (from docs search box)

* Dialog boxes
  * dialog box moves on new vs add
  * Load dialog upper bound of 365 days? and UI weirdness from that.

* Better handling of docs I don't have permission to (vs deleted)
  * rename `is_deleted` to `in_trash`
  * add a `not_accessible` bit
  * support adding these from gmail notifications, with fill-in title and notes
  * try flow of adding a doc I am requesting permission to, with notes about what it was

* "No comments on this doc" still shows if we try to load and fail.
* Make refresh on a doc faster, and probably cheaper, by doing fewer API calls.
* Mute state on docs
* keyboard shortcuts
* consider saving loaded comments
* consider preloading comments earlier (maybe from docs page too)
* consider Comment/Reply vs Ask states - am I expecting an answer?

* hosting
  * cloud run
  * deployment scripts
* offline mode - run with a database but no API login
    * can the agent use this autonomously in a browser to test?

* add a doc I'm requesting permission to
  * record notes about where it came from, when I asked permission
  * built-in tag for PermissionPending, transition when I get permission

* chrome plugin
  * add a doc
  * standalone add page / dialog
  * capture linked-from notes when requesting permission
  * scroll to comments in the doc window without reloading

* testing strategies
* sandbox test environment
* snapshot database and simulated or recorded google APIs
* demo version with some fake docs or a starting snapshot

* embedded pgvector index for semantic search on docs, titles, comments

* can we open the doc diff viewer
* can we find a way to open diffs between timestamps we choose?

* cosmetic
  * better visual for the cross-out filter buttons
  * tooltip display for longer notes
  * editable notes box inline on the comments page?
  * rendering glitch when toggling filters makes scroll bar appear

## gaps
* no way to get suggestions cheaply or incrementally
  * we have to read doc contents and extract all the inlined suggestions
* we can't get comments incrementally.  we always scan all of them.
* for suggestions, there's minimal API support.
  * we can't see the replies, author, accept/reject state, etc.
  * we can't accept or remove via API
* for comments, we can't tell if they're attached to deleted text
  * the reported anchor location is immutable, from time of creation
  * the quoted text is also immutable
  * the quoted text doesn't pass through formatting, just plain text
    * nothing for images. for tables, seems to just give the top row.
    * we don't get clickable links in the view
* *the quoted text we display for comments is always a snapshot from creation time*

## consider later
* we fetch all comments with full reply text when opening the comments page
  * if there are a lot of comments, it might make sense to split that up
  * maybe just fetch the initial comments first
* add a screen for labeling new docs that appeared during a refresh?
* check and refine rules for detecting hasNewActivity on comment threads - reply count, change timestamp, etc.

## low priority
* rename a label

## tools
* Figure out how to get playwrite MCP to work so it can look at a browser

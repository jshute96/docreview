required cleanup:
* disable debug logging on drive changes scan
* decide whether to keep last-view-time pinning on Reply/Resolve
    * clean up UI for edit-last-viwed-timestamp
* strip personal data from logs

P0:

P1:
* handle gmail notifications
  * share request emails - from me, to me
  * suggestions - what can we capture?
    * links with proper ID inside the doc?
    * accept/reject links
    * thread contents? (maybe)
  * requesting your review
  * item assigned to you
* testing
  * test scripts for playwright testing of all interactions
* no user info the database - fetch doc titles live
  * cache them in browser-local state?
* help screen, intro pages
* "delete all my data" menu item
* Load dialog - load months, or load all
* check: Can we get comment locations in the doc contents fetch? (to get current location and commented text.)

Easy:
* scroll bars for lots of docs
* Button for search in Drive (from docs search box)
* load dialog is too tall, collapse the first section
* Text is hard to read on unselected tags.  Especially white.
* X-to-clear button when editing notes
* link URL includes filters, labels, etc.

* Remember state/tag for @mentioned on comment, with mine/replied and resolved
* Cancel API requests and other work on tab close?

* Dialog boxes
  * dialog box moves on new vs add
  * Load dialog upper bound of 365 days? and UI weirdness from that.

* Better handling of docs I don't have permission to (vs deleted)
  * rename `is_deleted` to `in_trash`
  * add a `not_accessible` bit
  * support adding these from gmail notifications, with fill-in title and notes
  * try flow of adding a doc I am requesting permission to, with notes about what it was

* Make refresh on a doc faster, and probably cheaper, by doing fewer API calls.
* Mute state on docs
* keyboard shortcuts
* consider saving loaded comments
* consider preloading comments earlier (maybe from docs page too)
* consider Comment/Reply vs Ask states - am I expecting an answer?

* hosting
  * cloud run
  * deployment scripts
* offline mode - run with a database but no API login (sort of works already, requires logout)

* add a doc I'm requesting permission to
  * record notes about where it came from, when I asked permission
  * built-in tag for PermissionPending, transition when I get permission

* chrome plugin
  * add a doc
  * capture linked-from notes when requesting permission
  * scroll to comments in the doc window without reloading

* sandbox test environment
* snapshot database and simulated or recorded google APIs
* demo version with some fake docs or a starting snapshot

* can we open the doc diff viewer
* can we find a way to open diffs between timestamps we choose?

* can we get google docs to navigate to selected comments seamlessly
  * some work in docs/notes-on-comment-navigation.md

## cosmetic
* better visual for the cross-out filter buttons
* tooltip display for longer notes
* editable notes box inline on the comments page?
* rendering glitch when toggling filters makes scroll bar appear
* "No comments on this doc" still shows if we try to load and fail.

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
* embedded pgvector index for semantic search on docs, titles, comments

## low priority
* rename a label
* help for URLs: where to reference /add?doc=ID, etc.

## wishlish for google APIs
* suggestions don't work in APIs at all
  * should be able to fetch them like comments, see replies, etc.
  * should be able to reject and accept
  * should use same AAAB... IDs as comments, not suggest... that gets embedded in docs
  * should be able to link to a suggestion location with ?disco=ID links
* comments
  * should be able to get current doc text (it only gives the original text)
  * should give current anchor location or unanchored state (it only has original location)

## Possible V2 features
* build doc veiwer and diff viewer, take over from doc's lame differ
* support markdown docs too, with the same workflow, with comments in code review tools
* plugin model so we can support other doc&comments backends


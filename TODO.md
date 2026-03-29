required cleanup:
* decide whether to keep last-view-time pinning on Reply/Resolve
  * is it doing anything useful?  docs' diff viewer is ignoring it.
  * clean up UI for edit-last-viwed-timestamp
* remove redirect-resolve logging

P0:

P1:
* handle gmail notifications
  * share request emails - from me, to me
  * requesting your review
* Rewrite help text content.  It's AI generated excepted the Getting Started page.
* cache comments in the local DB
* cache suggestion thread contents from gmail in the local DB

Easy:
* scroll bars for lots of docs
* Button for search in Drive (from docs search box)
* load dialog is too tall, collapse the first section
* Text is hard to read on unselected tags.  Especially white.
* link URL includes filters, labels, etc.

* Cancel API requests and other work on tab close?

* keyboard shortcuts
* consider saving loaded comments

* hosting
  * cloud run
  * deployment scripts

* permission request flows
  * auto-add a doc when I request permission to see it
  * record notes about where it came from, when I asked permission
  * built-in tag for PermissionPending, transition when I get permission
  * show pending permission requests somehow

* chrome extension
  * capture linked-from notes when requesting permission
  * bi-directional linking - click a comment in the doc or docreview, focus that comment in the other too
  * get better content for suggestions from open docs, vs limited info we have from the API
  * accept or reject suggestions by sending clicks to buttons in docs (there's no API for this)
  * maybe: context-menu items for links to docs (maybe shortened links too) for docreview actions
  * maybe: inline/popup docreview status - labels, etc.
  * cosmetic: icon placement in title is glitchy while the page is loading and things move around
  * cosmetic: in drive, omit docreview links for files of unsupported types
  * testing: get automated testing working. see `testing/chrome-extension.md`.

* testing
  * UI testing working in offline mode - get more cases working, with live google apps, chrome extension
  * **Test cases**: See `testing/TODO.md` for tests to add in e2e tests.
  * maybe: snapshot database and/or simulated or recorded google APIs
  * maybe: demo version with some fake docs or a starting snapshot

* diffs
  * can we open the doc diff viewer
  * can we find a way to open diffs between timestamps we choose?

## cosmetic
* better visual for the cross-out filter buttons
* tooltip display for longer notes
* editable notes box inline on the comments page?
* rendering glitch when toggling filters makes scroll bar appear
* "No comments on this doc" still shows if we try to load and fail.
* dialog boxes move around too much, because they resize but stay centered

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
* other locales / languages - some parsing code for emails, times and dates, etc, won't work right

## consider later
* we fetch all comments with full reply text when opening the comments page
  * if there are a lot of comments, it might make sense to split that up
  * maybe just fetch the initial comments first
* add a screen for labeling new docs that appeared during a refresh?
* check and refine rules for detecting hasNewActivity on comment threads - reply count, change timestamp, etc.
* embedded pgvector index for semantic search on docs, titles, comments
* gmail notificaitons include a reply-to for adding replies to a suggestion by email. we could use that to allow adding replies (but not accept/reject).

## low priority
* rename a label
* help for URLs: where to reference /add?doc=ID, etc.
* when the extension checks for redirect links, it briefly opens a tab to try loading the page.  There are alternative ways, but complicated and with caveats.
* assembling suggestion text from docs content is complex with multi-fragment overlapping suggestions, and causes some bugs or caveats, including matching to gmail by content hash.

## wishlish for google APIs
* suggestions don't work in APIs at all
  * should be able to fetch them like comments, see replies, etc.
  * should be able to reject and accept
  * should use same AAAB... IDs as comments, not suggest... that gets embedded in docs
  * should be able to link to a suggestion location with ?disco=ID links
  * should see formatting suggestions somehow, but they aren't visible anywhere
* comments
  * should be able to get current doc text (it only gives the original text)
  * should give current anchor location or unanchored state (it only has original location)
  * should have a way to get emoji reactions on comments
  * should have a way to set assigneeEmailAddress from the API

## Possible V2 features
* build doc veiwer and diff viewer, take over from doc's lame differ
* support markdown docs too, with the same workflow, with comments in code review tools
* plugin model so we can support other doc&comments backends
  * code reviews too?
* support other non-docs documents - any readable URL?  other drive files with comments?

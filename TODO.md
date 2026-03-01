* Better handling of docs I don't have permission to (vs deleted)
* Load... dialog box

* Make refresh on a doc faster, and probably cheaper, by doing fewer API calls.
* If someone else resolves my thread, that comment should stay active/watched?
* gmail scan
* how do I notice @mentions?
* Mute state on docs
* Track what comments I've seen, and show the new ones in a different color
* Expand all / collapse all on comments page
* keyboard shortcuts
* consider saving loaded comments
* consider preloading comments earlier (maybe from docs page too)

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

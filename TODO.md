* Suggestions fetching is still limited and sketchy
  * No timestamps, no response counts
  * Anchor links into the doc don't work
  * There's no timestamp-based detection of new ones or updates, so there might
    be excessive polling

* Make refresh on a doc faster, and probably cheaper, by doing fewer API calls.
* Use last comments sync timestamp during doc refresh
* If someone else resolves my thread, that comment should stay active/watched?
* gmail scan
* how do I notice @mentions?
* dialog box for filtering what to Load from Drive
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

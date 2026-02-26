* Suggestions fetching is still limited and sketchy
  * No timestamps, no response counts
  * Anchor links into the doc don't work
  * There's no timestamp-based detection of new ones or updates, so there might
    be excessive polling

* Make refresh on a doc faster, and probably cheaper, by doing fewer API calls.
* Use last comments sync timestamp during doc refresh
* If someone else resolves my thread, that comment should stay active/watched?
* gmail scan
* dialog box for filtering what to Load from Drive
* add/remove labels from multiple docs (multi-select or filtered view)
* Mute state on docs
* Track what comments I've seen, and show the new ones in a different color
* UI: merge label filter with other state filtering
* Search/filter box on comments/ view.
* keyboard shortcuts
* tooltips on all the buttons, columns, etc

* hosting
  * cloud run
  * deployment scripts
* testing?
* offline mode - run with a database but no API login
    * can the agent use this autonomously in a browser to test?

* chrome plugin for adding a doc
* chrome plugin for scrolling to comments in the doc window without reloading

* sandbox test environment
* snapshot database and simulated or recorded google APIs
* demo version with some fake docs or a starting snapshot

* can we open the doc diff viewer
* can we find a way to open diffs between timestamps we choose?

* cosmetic
  * better visual for the cross-out filter buttons

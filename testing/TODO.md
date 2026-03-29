# E2E Test TODO

User-facing behaviors that need Playwright e2e test coverage.
Excludes behaviors already covered by existing tests or unit tests.

Update this list when adding or changing user-facing behaviors that
don't yet have e2e coverage.

---

## Document List Page (`/docs`)

### Display & Layout
- [ ] Document rows show: type icon, title, role badge, star, comment counts (unread/inbox/open), label badges, truncated notes (full on hover), archive button, edit button
- [ ] Row highlighting: red background for assigned comments, amber for unreplied @mentions
- [ ] Access-denied docs show strikethrough title, gray text, red indicator ("In trash" / "Not accessible" / "Permission denied")
- [ ] Empty state: "No docs yet" when no documents tracked
- [ ] Empty filter state: "No docs match filters" when filters exclude everything
- [ ] Page title updates based on active filters

### Sorting
- [ ] Click column headers to sort (title, unread, inbox, open, last comment, last modified)
- [ ] Click again to reverse sort direction
- [ ] Default sort: last comment, descending

### Filtering
- [ ] Tri-state filter toggles: off → include → exclude for inbox/archived, author/reviewer, starred, has comments
- [ ] Slow-click-to-reset: pause >500ms resets filter instead of cycling to next state
- [ ] Document type filters (Docs / Sheets / Slides)
- [ ] Label filters (one per label, AND logic when multiple active)
- [ ] Title (and notes) search with regex and substring support
- [ ] Search highlights matching text in doc titles and notes
- [ ] Multiple filters combine with AND logic

### Toolbar Actions
- [ ] Refresh button shows progress toast, updates doc list with summary
- [ ] Add button opens Add Document dialog
- [ ] Load button opens Load dialog
- [ ] Manage Labels button opens label management
- [ ] Help button opens help dialog
- [ ] Hamburger menu items: refresh from Drive only, refresh from Gmail only, refresh selected, full refresh, add doc page, chrome extension link, clear cache, delete all data, sign out

### Row Actions
- [ ] Star toggle persists and broadcasts cross-tab
- [ ] Archive/unarchive toggle persists, updates row, broadcasts cross-tab
- [ ] Edit button opens Edit Document dialog
- [ ] Clicking doc title navigates to comments page

---

## Document Detail / Comments Page (`/comments/[docId]`)

### Header
- [ ] Displays title, role, status, star, labels, notes, owner, dates
- [ ] Menu: untrack document, delete & re-add
- [ ] Red warning banners for trashed / not accessible / permission denied docs
- [ ] Star toggle from header
- [ ] Refresh this doc
- [ ] Archive/unarchive this doc
- [ ] Open google doc

### Show Modes
- [ ] Inbox mode (default): only inbox-status threads
- [ ] Open mode: all unresolved threads
- [ ] All mode: every thread including archived/muted

### Comment Filters
- [ ] Tri-state toggles: Mine, Replied, Assigned, @Mentioned, Resolved, Unread, Starred, Suggestions
- [ ] Search bar: case-insensitive, supports regex or substring
- [ ] Search highlights matching text in comments
- [ ] Filters combine with AND logic against show mode

### Comment Table
- [ ] Rows show: status badges, preview text with author, timestamps, reply count
- [ ] Row highlighting: red (assigned/unresolved/inbox), amber (unreplied mention/unread), green (read)
- [ ] Click row to expand thread

### Thread Panel
- [ ] Shows original comment with quoted document text
- [ ] All replies in chronological order
- [ ] Reply textarea (Enter or Send to submit)
- [ ] Resolve / Reopen button
- [ ] Status controls: inbox / archived / muted
- [ ] Star toggle per comment
- [ ] Mark read / unread toggle
- [ ] "Open in Google Docs" link
- [ ] Refresh action

### Suggestions Display
- [ ] Suggestions appear in same table as comments
- [ ] Show proposed insertion, deletion, or edit text
- [ ] Can archive, mute, star, filter like comments

### Bulk Actions
- [ ] Expand/Collapse all threads
- [ ] Expand all unread threads
- [ ] Archive/unarchive all read
- [ ] Mark all read/unread
- [ ] Archive all resolved

### Sort Freeze Behavior
- [ ] Sort order freezes during single-comment interaction (reply, resolve, status change)
- [ ] Sort icon switches to unselected state (↕) when frozen
- [ ] Clicking any column header or Refresh unfreezes and re-sorts

---

## Add Document Page (`/add`)

- [ ] Paste Google Docs/Sheets/Slides URL, validates and shows title + owner
- [ ] Accept doc ID as well as full URL
- [ ] Accept redirect-service link
- [ ] Set role (Author/Reviewer), labels, notes, star before adding
- [ ] "Add to Inbox" checkbox
- [ ] Add, Add & Open, Clear buttons
- [ ] If document already tracked: shows link to comments page, offers Update / Update & Open
- [ ] Last-added document summary with link
- [ ] Broadcasts doc change cross-tab after add

---

## Add Document Dialog (from doc list)

- [ ] Quick add single document via URL
- [ ] Same validation flow as Add page
- [ ] Broadcasts doc change cross-tab after add

---

## Open Document link (`/open`)

- [ ] Redirect to comments page if doc exists
- [ ] Redirect to add page if it doesn't

---

## Edit Document Dialog

- [ ] Role toggle: Author ↔ Reviewer
- [ ] Status toggle: Inbox ↔ Archived
- [ ] Star toggle
- [ ] Label picker with checkboxes (ordered by position)
- [ ] Notes textarea with auto-resize
- [ ] Save persists all changes; Cancel discards
- [ ] Broadcasts cross-tab after save
- [ ] Available from both doc list rows and comments page

---

## Bulk Edit Dialog

- [ ] Multi-select docs: click (single), Ctrl/Cmd+click (toggle), Shift+click (range)
- [ ] Remove docs from selection via X or Delete/Backspace
- [ ] "N documents selected" count updates
- [ ] Tri-state controls for role, status, star, labels (off/set/clear)
- [ ] State shows selected or unselected if all docs agree, or ? if not
- [ ] State can be + or - to add or remove the tag from all docs (excluded if that would be a no-op)
- [ ] Notes field appends to existing (doesn't replace), with smart newline insertion
- [ ] Save applies changes; skips unchanged docs
- [ ] Toast shows count of updated/skipped docs

---

## Load Dialog (two-phase import)

### Phase 1 — Scan
- [ ] Source toggle: Drive or Gmail
- [ ] Time window: by days, months, years, or "all"
- [ ] Ownership filter (Drive only): all, only owned, only shared with me
- [ ] Shared drives checkbox (Drive only)
- [ ] Scan button with progress toast
- [ ] Error count shown if any docs couldn't be resolved

### Phase 2 — Review & Add
- [ ] View toggle: New (untracked only) vs All (with NEW badges)
- [ ] Remove individual docs via X button
- [ ] Apply labels and notes to all imports
- [ ] "Add to Inbox" toggle
- [ ] Add button imports selected docs
- [ ] Toast summarizes results (added, updated)

---

## Delete All Data Dialog

- [ ] Two-step confirmation
- [ ] Option: delete data only vs delete + sign out
- [ ] Clears browser cache
- [ ] Broadcasts cross-tab (other tabs reload or redirect)

---

## Help Dialog

- [ ] Page navigation (prev / next)
- [ ] Page selector dropdown
- [ ] Keyboard navigation (arrow keys)
- [ ] Content renders correctly from markdown

---

## Welcome Dialog

- [ ] Shows automatically on first login (hasSeenHelp=false)
- [ ] Marks help as seen on close
- [ ] Does not show on subsequent visits

---

## Cross-Tab Sync

- [ ] Doc list updates when another tab adds/edits/archives a doc
- [ ] Comments page updates when another tab changes doc metadata
- [ ] Comments page updates when another tab syncs comments
- [ ] Add page label picker refreshes on label changes from other tabs
- [ ] Sign-out in one tab causes other tabs to redirect to login
- [ ] Debouncing: rapid broadcasts consolidate (300ms)

---

## Refresh & Sync Flows

### Discovery Refresh (default)
- [ ] Scans Drive changes feed + Gmail notifications in parallel
- [ ] Progress toast shows phases: discovery → metadata → comment sync
- [ ] Summary toast: "N documents (M new, P updated, Q deleted)"
- [ ] Newly discovered docs from Gmail go to Inbox
- [ ] Newly discovered docs from Drive go to Archived (unless comment activity triggers unarchive)
- [ ] First Refresh does 7 day lookback, later ones do incremental reads

### Full Refresh
- [ ] Fetches metadata for every tracked document
- [ ] Syncs comments for all docs

### Selected Refresh
- [ ] Only refreshes currently filtered/visible documents

### Single-Doc Refresh
- [ ] Refresh button on comments page syncs metadata + comments + suggestions
- [ ] Progress visible during sync

### Smart Unarchive
- [ ] Archived doc returns to Inbox on: new inbox comment, new @mention, reshare via Gmail
- [ ] Does NOT unarchive on: resolution-only activity, muted comments (unless @mentioned)
- [ ] Recency cutoff prevents stale docs from surfacing

---

## Comment Status & Sync Logic

### Auto-Status Assignment
- [ ] Author docs: all new comments go to Inbox
- [ ] Reviewer docs: only threads you participated in go to Inbox
- [ ] @mentions always go to Inbox (highest priority)
- [ ] Muted comments stay muted unless new @mention

### Comment Updates
- [ ] New reply on archived comment → unarchives to Inbox
- [ ] New @mention on muted comment → breaks out to Inbox
- [ ] Your own activity marks comment as read
- [ ] isRead sticky: sync only overwrites when thread has genuinely new activity

### Reply & Resolve
- [ ] Reply posts to Google Drive, syncs back
- [ ] Resolve posts to Drive, syncs back
- [ ] viewedByMeTime pinned during reply (doesn't mark doc as "viewed" in Drive)

---

## Gmail Integration

### Notification Scanning
- [ ] Discovers docs from comment notification emails (comments-noreply@docs.google.com)
- [ ] Discovers docs from sharing notifications (drive-shares-dm-noreply@google.com)
- [ ] Extracts document URLs from email body

### Share Notes
- [ ] Sharing emails create notes: "Shared by Name (email) on date\n[message]"
- [ ] Access request emails create notes: "Requested to share by Name..."
- [ ] New docs: sets as initial notes
- [ ] Existing docs: appends with newline

### Gmail-First vs Drive-First
- [ ] Gmail-discovered docs go to Inbox
- [ ] Resharing an archived doc via Gmail unarchives it to Inbox

---

## Synced Attributes

### From Drive API
- [ ] Title (name), MIME type, web view link
- [ ] Owner display name
- [ ] Last modified time, created time
- [ ] Trashed state
- [ ] viewedByMeTime (tracks if doc is "unread" in Drive)

### From Drive Comments API
- [ ] Comment ID, resolved state, created/modified times
- [ ] Author name and fromMe flag
- [ ] assigneeEmailAddress → assignedToMe
- [ ] mentionedEmailAddresses → mentionedMe, mentionedMeUnreplied
- [ ] Reply count, reply authors, reply actions (resolve/reopen/accept/reject)
- [ ] Comment content (text + HTML)
- [ ] Quoted file content (the text the comment refers to)

### From Docs API (suggestions)
- [ ] Suggestion IDs, inserted text, deleted text
- [ ] Suggestion type: insert, delete, edit
- [ ] Pending/accepted/rejected status

---

## Chrome Extension

### Toolbar icon
- [ ] On blank page, opens docreview
- [ ] On a google doc, go to /open for that doc
- [ ] On gmail, go to /open for that doc if it's a notification email
- [ ] On other pages, give an error

### Titlebar Badge (Google Docs/Sheets/Slides)
- [ ] Click badge opens doc in Docreview (navigates to comments page if tracked, add page if not)
- [ ] Badge links to correct Docreview URL based on tracking state

### Access-Denied Pages
- [ ] "Add in Docreview" link appears above "Request access" button
- [ ] Link pre-fills notes with date and access-denied context

### Google Drive Icons
- [ ] Icons appear next to files in list view and grid view
- [ ] Icons link to correct Docreview page
- [ ] Folders excluded

### Gmail Integration
- [ ] Attachment chips in inbox get Docreview icons
- [ ] Comment/suggestion notification emails get "Open in Docreview" link
- [ ] Sharing invitation emails get "Open in Docreview" link
- [ ] Links resolve doc URL at click time (Gmail changes content without reloading, so injection-time URLs go stale)

### Comment Activity Auto-Sync
- [ ] Detects: new comment, reply, resolve, accept suggestion, reject suggestion
- [ ] Syncs changes back to Docreview without manual refresh
- [ ] Debounces rapid actions (1s cooldown, leading + trailing)
- [ ] Updates all open Docreview tabs via cross-tab broadcast
- [ ] Server uses hints for optimized sync (single-comment fetch when possible)

### Comment Navigation (Docreview → Google Docs)
- [ ] Clicking "Open" on comment scrolls to it in Google Docs without page reload
- [ ] Opens resolved comments pane if needed
- [ ] Closes resolved comments pane if not needed
- [ ] First click opens new tab; subsequent clicks reuse same tab
- [ ] Falls back to page reload if navigation script fails
- [ ] Doesn't trample diff/version-history views in Google Docs (from recent changes button or view activity menu) — opens another tab instead

### Comment Selection Sync (bidirectional)
- [ ] Selecting comment in Google Docs highlights it in Docreview
- [ ] Selecting comment in Docreview selects it in Google Docs (without focusing tab)

### URL Resolution
- [ ] Resolves shortened URLs (go/doc-name style) via background tab
- [ ] Uses browser cookies for authentication
- [ ] Returns resolved Google Docs URL

### Tab Reuse
- [ ] Comments links reuse tabs via named window targets (dr-{docId})
- [ ] Doc links reuse tabs via named window targets (doc-{docId})
- [ ] Extension tracks docId → tabId for cross-context-group reuse
- [ ] Handles tabs opened outside web app's browsing context

### Configuration
- [ ] Server URL setting (syncs across Chrome devices)
- [ ] Per-service toggles: Docs, Drive, Gmail
- [ ] Comment activity sync toggle (sub-toggle of Docs)
- [ ] URL resolver toggle with host whitelist

---

## Multi-User Flows

- [ ] Two users, each with tracked docs: docs owned by User A appear with role=Author for A, role=Reviewer for B (if B tracks them)
- [ ] User A comments on doc → appears in User B's inbox (if B tracks it)
- [ ] User A resolves comment → User B sees it resolved after refresh
- [ ] User A shares doc with User B → B discovers it via Gmail scan with share notes
- [ ] User A @mentions User B → comment goes to B's inbox with @Mentioned badge
- [ ] User A assigns comment to User B → appears with Assigned badge in B's view
- [ ] User A replies to User B's archived comment → User B's comment unarchives
- [ ] Doc ownership affects default role assignment on import
- [ ] User B loses access to doc → access state updates to DENIED on next refresh
- [ ] User B regains access → auto-recovers to OK state

---

## Error Handling & Edge Cases

- [ ] Expired OAuth token: toast "Your Google session has expired. Please sign out and sign back in."
- [ ] Rate limiting / transient API errors: refresh can be retried, no data loss
- [ ] Document permanently deleted: marked NOT_FOUND, preserved in list with metadata
- [ ] Document trashed: marked TRASHED, removed from Inbox
- [ ] Partial refresh failure: summary shows error count, successful syncs still applied
- [ ] Offline mode: all Drive/Docs/Gmail API calls gracefully skipped with logged warnings
- [ ] Login errors: contextual error messages on login page (CredentialsSignin, AccessDenied)

---

## Multi-Tab Documents (Google Docs with multiple tabs)

### Suggestions
- [ ] Suggestions on non-first tabs are detected and synced
- [ ] Suggestion text (inserted/deleted) is correct for each tab
- [ ] Suggestion type (insert/delete/edit) is correct across tabs
- [ ] Resolved suggestions on non-first tabs are correctly marked resolved
- [ ] Document text includes content from all tabs (for anchor matching)
- [ ] This all works on multi-level nested tabs too

### Comments
- [ ] Comments on non-first tabs appear in comments list
- [ ] Comment quoted text is correct for comments on non-first tabs
- [ ] Reply/resolve works for comments on non-first tabs
- [ ] Comment deep links (?disco=) work for comments on non-first tabs
- [ ] This all works on multi-level nested tabs too

### Chrome Extension
- [ ] Extension suggestion scraping finds suggestions on all tabs
- [ ] Extension comment activity sync works for actions on non-first tabs
- [ ] Comment navigation (Docreview → Google Docs) works for comments on non-first tabs
- [ ] Comment selection sync works across tabs
- [ ] This all works on multi-level nested tabs too

---

## Sheets & Slides

### Google Sheets
- [ ] Adding a Google Sheet by URL works (validation, title, owner)
- [ ] Refresh syncs comments on Sheets
- [ ] Comments from multiple sheets appear in comments list
- [ ] Reply/resolve works for Sheet comments
- [ ] Document text export includes content from all sheets
- [ ] Sheet type icon displays correctly in doc list

### Google Slides
- [ ] Adding a Google Slides presentation by URL works (validation, title, owner)
- [ ] Refresh syncs comments on Slides
- [ ] Comments from multiple slides appear in comments list
- [ ] Reply/resolve works for Slides comments
- [ ] Document text export includes content from all slides
- [ ] Slides type icon displays correctly in doc list

### Chrome Extension (Sheets & Slides)
- [ ] Titlebar badge appears on Google Sheets and links to Docreview
- [ ] Titlebar badge appears on Google Slides and links to Docreview
- [ ] Comment activity auto-sync works on Sheets
- [ ] Comment activity auto-sync works on Slides
- [ ] Comment click navigation works on Sheets
- [ ] Comment click navigation works on Slides

---

## Browser Cache & Performance

- [ ] Document titles cached in localStorage (prevents title flicker on load)
- [ ] Clear cache menu option removes cached data
- [ ] Stale cache entries evicted (not accessed in 30 days)
- [ ] Real-time progress updates stream to the browser during long operations (refresh, load, scan)

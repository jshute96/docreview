# E2E Test Coverage

User-facing behaviors and their Playwright e2e test coverage status.
Checked items have existing tests; unchecked items still need coverage.

Update this list when adding or changing user-facing behaviors.

* Checked items (`[x]`) are done.
* Items with `[*]` have caveats and might not be possible to cover in automated tests.

---

## Authentication & Smoke Tests

### Offline Mode

**Files:** `app-offline/smoke.spec.ts`

- [x] Login page auto-signs in and redirects to /docs
- [x] /docs page loads successfully
- [x] /comments page loads successfully
- [x] /add page loads successfully
- [x] Unauthenticated request redirects to /login
- [ ] Sign out clears session and redirects to /login

### Live Mode

**Files:** `app-live/login.spec.ts`, `app-live/docs.spec.ts`

- [x] Authenticated session loads /docs with real data
- [x] Doc list shows documents with real titles (not "Untitled")
- [ ] Google OAuth login redirects to /docs on success
- [ ] Unauthenticated request redirects to /login
- [ ] Login errors: contextual error messages on login page (CredentialsSignin, AccessDenied)
- [ ] Sign out clears session and redirects to /login
- [ ] Expired OAuth token: toast prompting re-auth

---

## Document List Page (`/docs`)

**Files:** `app-offline/docs.spec.ts`

### Display & Layout
- [x] Document rows display with title links to /comments/
- [x] Doc rows have action buttons (Open, Archive/Unarchive)
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
- [x] Clicking doc title navigates to comments page
- [ ] Star toggle persists and broadcasts cross-tab
- [ ] Archive/unarchive toggle persists, updates row, broadcasts cross-tab
- [ ] Edit button opens Edit Document dialog

---

## Document Detail / Comments Page (`/comments/[docId]`)

**Files:** `app-offline/docs.spec.ts`

### Header
- [x] Shows doc metadata and comments section
- [x] Back navigation (logo) returns to docs list
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
- [x] Click row to expand thread
- [ ] Rows show: status badges, preview text with author, timestamps, reply count
- [ ] Row highlighting: red (assigned/unresolved/inbox), amber (unreplied mention/unread), green (read)

### Thread Panel

**Files:** `app-live/comments.spec.ts`

- [x] Shows original comment text
- [x] Reply textarea and Reply button
- [x] Reply appears in thread after posting
- [x] Resolve marks comment resolved (badge in thread, open count decreases)
- [x] Reopen with text reopens comment (Reopened badge, text shown, open count increases)
- [x] Resolve with text resolves comment (Resolved badge + text shown, open count decreases)
- [ ] Shows quoted document text
- [ ] All replies in chronological order
- [ ] Status controls: inbox / archived / muted
- [ ] Star toggle per comment
- [ ] Mark read / unread toggle
- [ ] "Open in Google Docs" link
- [ ] Refresh action

### Suggestions Display
- [ ] Suggestions appear in same table as comments
- [ ] Orphaned suggestions (original content deleted) show "Original content deleted" warning (using state from the extension)
- [ ] Orphaned comments (original content deleted) show "Original content deleted" warning (using state from the extension)
- [ ] When extension confirms comment is NOT orphaned but anchor text doesn't match document, show softer "original text has changed" message instead of "text no longer exists" warning
- [ ] Show proposed insertion, deletion, or edit text
- [ ] Text-change suggestions (INSERT/DELETE/EDIT) do not show anchor text blockquote
- [ ] Non-text suggestions show "Suggestion: description" with anchor text blockquote
- [ ] Non-text suggestions show "on ..." suffix in collapsed row
- [ ] Expanded suggestion renders like a comment: anchor blockquote, author+date, content (green if mine)
- [ ] Unknown author shows "Unknown author" in expanded view
- [ ] User's own name shown (not "Unknown author") for own suggestions when userName available
- [ ] Synthesized thread hint: "process in doc" when no extension, "synced from Drive" when no disco ID, "open the doc" when extension available
- [ ] Search filter matches suggestion descriptions and anchor text
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

## Label Management

**Files:** `app-offline/labels.spec.ts`, `app-offline/labels-crosstab.spec.ts`

### Manage Labels Dialog
- [x] Create labels via Manage Labels dialog (with persistence to DB)
- [x] Reorder labels via drag-and-drop (reflected in badges and DB positions)
- [x] Change label color (reflected in doc row badges and DB)
- [x] Cancel discards unsaved changes (color, reorder, new labels)
- [x] Delete label: cancel confirm keeps it; cancel dialog keeps it on docs page
- [x] Delete label: confirm and save removes from all doc rows and DB (cascade)

### Label Assignment
- [x] Assign labels to docs via Edit dialog (badges appear on rows, persisted to DB)

### Cross-Tab Label Sync
- [x] Label changes broadcast to /docs page (filter bar and doc row badges)
- [x] Label changes broadcast to /comments page (doc labels section)
- [x] Label changes broadcast to /add page (label picker)
- [x] Label changes broadcast to /docs with Add dialog open (label picker)
- [x] Label changes broadcast to /docs with Edit dialog open (label picker)
- [x] Label changes broadcast to /comments with Edit dialog open (label picker)
- [x] Label changes broadcast to /docs with Manage Labels dialog open
- [x] Database state remains consistent after cross-tab sync

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
- [ ] Redirect correctly after resolving a redirect-service link

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

**Files:** `app-offline/labels-crosstab.spec.ts` (label sync only)

- [x] Label changes sync across all open tabs and dialogs (see Label Management above)
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
- [ ] Extension-triggered comment sync unarchives doc when comment moves to Inbox
- [ ] Extension suggestion merge unarchives doc when suggestion moves to Inbox
- [ ] Gmail suggestion merge unarchives doc when suggestion is promoted/inserted as Inbox
- [ ] Does NOT unarchive on: muted comments (unless @mentioned), my own activity (isRead)
- [ ] Does NOT unarchive on suggestions where I was the last actor (e.g., I typed my own suggestion, I accepted/rejected it myself)
- [ ] Unarchives when existing INBOX suggestion gets a new non-self reply (suggestion rule 2)
- [ ] Unarchives when my INBOX suggestion is accepted/rejected by someone else (suggestion rule 3)
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

### Suggestion Updates (Chrome extension sync only — only source with reply-authorship data)
- [ ] Suggestion isRead set from last-actor-is-me: my reply/accept/reject → read; theirs → unread
- [ ] isRead for suggestion sticky across extension syncs when no new replies and no resolve-state change
- [ ] First-time extension enrichment of a Drive-/Gmail-first suggestion computes isRead fresh (doesn't preserve the schema-default false)

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

### No-Gmail Account (Google account with no Gmail mailbox)
- [ ] Gmail-only Refresh: shows "No Gmail account" warning toast and does NOT show "Gmail refresh complete"
- [ ] Combined Drive+Gmail Refresh: "No Gmail account" warning persists alongside the Drive "Refresh complete" success toast
- [ ] Load dialog with Gmail source: scan completes, shows "No Gmail account" warning instead of "Found N documents in Gmail"
- [ ] Refresh and Load both succeed without throwing or surfacing a generic error toast
- [ ] Server logs the underlying Gmail error (reason=failedPrecondition, full message) once per scan
- [ ] `Status.lastGmailUpdateTimestamp` is NOT advanced after a no-Gmail-account scan (so a later Gmail-enabled scan still covers the same window)

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
- [ ] Suggestion type: insert, delete, edit, other (formatting/links)
- [ ] Pending/accepted/rejected status
- [ ] Non-text suggestions (bold, italic, link, etc.) detected via suggestedTextStyleChanges
- [ ] Formatting suggestions show description (e.g. "Bold", "Add link: ...") and anchor text
- [ ] Formatting suggestions classified as OTHER, not EDIT
- [ ] Suggestions inside tables are detected and synced correctly
- [ ] Suggestions inside table of contents are detected and synced correctly
- [ ] Document text includes content from inside tables (for anchor text matching)
- [ ] Document text includes content from table of contents (for anchor text matching)
- [ ] Comment anchor text (quotedFileContent) matches even when the quoted text is inside a table

### Cross-source suggestion matching
- [ ] Content hash matches across Drive sync, Gmail sync, and extension sync for text suggestions
- [ ] Content hash matches across all three sources for OTHER (formatting) suggestions (all use empty strings)
- [ ] Drive-created suggestion matched by hash when Gmail notification arrives (no googleSuggestionId yet)
- [ ] Extension-created suggestion matched by hash when Drive sync runs
- [ ] Multiple formatting suggestions on same doc: hash collision doesn't cause incorrect merges (primary match uses IDs)
- [ ] Disco-only row (Gmail/extension-first, has googleCommentId) merges with suggestion-only partner (Docs-API-first, has googleSuggestionId) when both reference the same suggestion — one row remains, no duplicates
- [ ] Partner merge happens on all three sync paths (Drive, Gmail, Extension) when that path runs first after the two rows exist
- [ ] Gmail merge only fills `suggestionContentHash` when missing (does not overwrite a hash written by Drive or Extension, since Gmail text is a stale snapshot)

---

## Chrome Extension

### Toolbar Icon

**Files:** `extension-live/toolbar.spec.ts`

- [x] Extension loads and service worker starts
- [x] On blank page, opens docreview
- [x] On non-doc page, shows error alert
- [ ] On a google doc, go to /open for that doc
- [ ] On gmail, go to /open for that doc if it's a notification email

### Content Script Injection

**Files:** `extension-snapshot/content-script.spec.ts`

- [x] Google Docs: injects #dr-badge with .dr-link (titlebar badge)
- [x] Google Docs: idempotent — running twice produces one badge
- [x] Google Sheets: titlebar badge injected
- [x] Google Slides: titlebar badge injected
- [x] Google Drive list view: injects .dr-link into qualifying file rows
- [x] Google Drive list view: idempotent — no duplicates on re-run
- [x] Gmail inbox: injects .dr-link into [data-docurl] chips
- [x] Gmail inbox: idempotent — no duplicates on re-run
- [x] Gmail message view: injects .dr-gmail-bar above message iframe
- [x] Gmail message view: idempotent — one bar per message on re-run

### Titlebar Badge (Google Docs/Sheets/Slides)
- [ ] Click badge opens doc in Docreview (navigates to comments page if tracked, add page if not)
- [ ] Badge links to correct Docreview URL based on tracking state

### Access-Denied Pages
- [ ] "Add in Docreview" link appears above "Request access" button
- [ ] Link pre-fills notes with date and access-denied context

### Google Drive Icons
- [ ] Icons link to correct Docreview page
- [ ] Folders excluded

### Gmail Integration
- [ ] Attachment chips in inbox get Docreview icons
- [ ] Comment/suggestion notification emails get "Open in Docreview" link
- [ ] Sharing invitation emails get "Open in Docreview" link
- [ ] Links resolve doc URL at click time (Gmail changes content without reloading, so injection-time URLs go stale)

### Extension Comment/Suggestion Fetching
- [ ] `getComment(discoId)` finds comment in anchored view without opening pane
- [ ] `getComment(discoId)` opens pane and retries when comment not in anchored view (resolved/unanchored)
- [ ] `getSuggestion(discoId)` finds suggestion in anchored view without opening pane
- [ ] `getSuggestion(discoId)` opens pane and retries when suggestion not in anchored view
- [ ] `getComments()` / `getSuggestions()` / `getCommentsAndSuggestions()` load all comments before returning
- [ ] `loadAllComments()` short-circuits on subsequent calls after a successful settle, while items remain in the DOM
- [ ] `loadAllComments()` opens pane, waits for pane stream view to stop mutating (250ms settle), closes pane when pane was closed
- [ ] `loadAllComments()` returns full comment list on slow-loading docs (pane populates incrementally — no early close)
- [ ] `loadAllComments()` recovers on second call if first call timed out mid-load (partial DOM state must not be treated as complete)
- [ ] `loadAllComments()` waits without closing when pane was already open
- [ ] `loadAllComments()` waits for the "Show all comments" button to appear before clicking (slow page loads)
- [ ] `loadAllComments()` detects zero-state on doc with no comments (returns quickly, no 5s timeout)
- [ ] `loadAllComments()` returns for view-only doc (bounded by 5s deadline; doesn't hang)
- [ ] Refresh comment thread on comments/ page gets `originalContentDeleted` from extension

### Content Script Re-injection on Extension Reload
- [ ] After extension reload, content scripts are re-injected into existing Google Docs tabs (comment activity detection resumes without manual tab reload)
- [ ] After extension reload, bridge is re-injected into existing docreview tabs (ping/response and commentSynced notifications work without manual tab reload)
- [ ] Re-injection is idempotent: no duplicate icons or UI elements after re-inject
- [ ] Tabs in `loading` state are skipped (manifest handles them)
- [ ] Orphaned bridge suppresses "Extension context invalidated" errors (doesn't race with new bridge's responses)

### Tab Fallback for commentSynced Delivery
- [ ] When first docreview tab's bridge is stale, commentSynced is delivered to next available tab
- [ ] When all docreview tabs have stale bridges, warning is logged (no silent failure)

### Comment Activity Auto-Sync
- [ ] Detects: new comment, reply, resolve, accept suggestion, reject suggestion
- [ ] Detects: edit comment (via "..." > Edit > Save), edit reply
- [ ] Detects: delete comment thread (via "..." > Delete > confirm), delete reply
- [ ] Delete fires on confirm dialog button, not the menu item
- [ ] Delete or edit comment text, adding or removing @mentions - thread state updates
- [ ] Syncs changes back to Docreview without manual refresh
- [ ] Deleted comment: server returns empty threads (no 502 / stack trace)
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
- [ ] Navigation works on doc with no comments (no error from loadAllComments)
- [ ] Navigation works on view-only doc (no hang from loadAllComments)

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

### Link Context Menu
- [*] "Open in Docreview" appears on right-clicked Google Docs/Sheets/Slides/Drive links (manual only — context menus are native browser UI, not testable via Playwright; use `testing/extension_link_tests.html`)
- [*] "Open in Docreview" appears on right-clicked shortener links (bit.ly, tinyurl.com, t.co)
- [*] "Open in Docreview" does NOT appear on non-matching links (plain URLs, Drive folders, Google Forms)
- [*] Clicking "Open in Docreview" opens the doc in Docreview via /open

**Note:** Browser UI like context menus can't be tested automatically. Test manually with `testing/extension_link_tests.html`.

### Options Page

**Files:** `extension-live/options.spec.ts`

- [x] Options menu item opens as a full browser tab (not a popup/dialog)
- [ ] Server URL input defaults to 600px, grows with content
- [x] Reload page reverts edits to all fields.
- [x] Save button saves the changes.
- [x] Save button shows "Saved" confirmation briefly
- [x] Saved URL normalized to strip whitespace and trailing slashes, and display updates.
- [x] Unchecking Docs auto-unchecks comment sync
- [x] URL resolver toggle
- [x] Settings persist via chrome.storage.sync (syncs across Chrome devices)
- Saved settings reflected in extension behavior
  - [x] Docreview URL
  - [ ] Enable on Google Docs, Sheets, and Slides
  - [ ] Notify on comment activity
  - [ ] Enable on Google Drive
  - [ ] Enable on Gmail
  - [ ] Enable redirect-link resolver

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
- [ ] View-only doc: comments page shows comments from Drive API (no extension data)
- [ ] View-only doc: extension fetches (getComment, getSuggestion) return gracefully (no 5s hang)
- [ ] Doc with no comments: comments page shows empty state
- [ ] No-comment-permission doc: comments page shows "Comments not visible on this document." (not "No comments")
- [ ] No-comment-permission doc: Gmail-sourced comments appear in the comment list with placeholder suggestion details
- [ ] Doc with no comments: extension fetches return empty results quickly (zero-state detection)

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
- [ ] Refresh on the comments/ page syncs suggestions
- [ ] Refresh one suggestion from its thread on the comments/ page
- [ ] Opening a doc auto-fetches suggestions (in comments/ page) when doc's stream view is ready

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

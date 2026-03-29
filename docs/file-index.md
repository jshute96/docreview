# File Index

One-line descriptions of every source file, grouped by layer.

## Root Files

| File | Description |
|------|-------------|
| `README.md` | Primary project documentation — setup, stack, features, and commands |
| `AGENTS.md` | Guidance for AI agents working in this repository |
| `TODO.md` | Project roadmap and task list |

## Core (`src/`)

| File | Description |
|------|-------------|
| `auth.ts` | NextAuth v5 configuration — handles Google OAuth and Offline mode providers, session strategy, and token persistence |
| `test-utils.ts` | `suppressingErrors()` — wraps test blocks to suppress expected console.error output |

## Pages (`src/app/`)

| File | Description |
|------|-------------|
| `page.tsx` | Root redirect — sends authed users to `/docs`, others to `/login` |
| `layout.tsx` | Root layout — Geist fonts, global CSS, Sonner toaster |
| `not-found.tsx` | Global 404 page — centered message with link back to docs list |
| `login/page.tsx` | Login page — Google OAuth button, or offline-mode button |
| `docs/page.tsx` | Doc list page (server) — fetches docs+labels, renders `DocTable` |
| `add/page.tsx` | Add document page (server) — standalone add-doc form, accepts optional `?doc=` and `?notes=` query params |
| `open/page.tsx` | Open page (server) — redirects to `/comments/<docId>` if doc exists, otherwise to `/add?doc=...` |
| `comments/[docId]/page.tsx` | Doc detail page (server) — fetches single doc with comments, renders `DocDetail`; page title set client-side via `DocDetail` |

## Chrome Extension (`src/chrome-extension/`)

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3 config — permissions, host permissions, content script registration, service worker |
| `background.js` | Service worker main — toolbar click, context menus, message handler, comment navigation, URL resolution, bridge registration |
| `background-injected.js` | Functions injected into page context — disco ID helpers, comment selection/navigation, Gmail doc URL extraction |
| `background-tabs.js` | Doc tab tracking — maps docId → tabId for in-page comment navigation |
| `background-comments.js` | Comment sync state — pre-extracted comment IDs, debounce logic, server sync |
| `content.js` | Content script — injects Docreview icons into Docs titlebar, Drive file lists, Gmail notification emails |
| `content-comments.js` | Comment activity detection (Docs only) — detects comment/suggestion actions, relays selection changes |
| `defaults.js` | Shared default config (base URL) loaded by all other scripts |
| `options.html` | Settings page HTML — single URL input with Save/Cancel |
| `options.js` | Settings page logic — reads/writes `chrome.storage.sync` |
| `bridge-to-docreview.js` | Content script for Docreview app pages — relays messages between the web page and background worker via `window.postMessage` |
| `icons/` | Extension icons (16/48/128px PNGs converted from `public/docreview.svg`) |
| `README.md` | User-facing docs — features, installation, configuration, architecture overview |

## Help System (`public/help/`)

| File | Description |
|------|-------------|
| `viewer.html` | Standalone markdown renderer loaded in iframe — fetches `.md` by `?page=` param, renders with marked.js CDN, forwards navigation keys to parent via postMessage |
| `pages.json` | Ordered page index for help dialog navigation (slug + title pairs) |
| `quick-start.md` | Quick Start guide — adding documents, document list, comments view, Chrome extension |
| `concepts.md` | Core concepts — documents, comments/suggestions, statuses, smart unarchive, labels, tri-state filtering |
| `document-list.md` | Document list page — row layout, counts, highlighting, access states, sorting, filters |
| `document-details.md` | Document details page — header, show modes, filters, search, threads, suggestions, bulk actions |
| `loading-documents.md` | Loading documents — Refresh, Load dialog two-phase flow, Add doc page |
| `labels-and-notes.md` | Labels & notes — managing labels, applying them, filtering, notes, edit/bulk edit dialogs |
| `chrome-extension.md` | Chrome extension — installation, injected icons, toolbar, context menu, configuration |
| `privacy-policy.md` | Privacy policy — permissions, data storage, authentication, data sharing |

## Assets (`public/`)

| File | Description |
|------|-------------|
| `docreview.svg` | The official Docreview brand icon (violet square with document lines) |

## API Routes (`src/app/api/`)

| File | Description |
|------|-------------|
| `auth/[...nextauth]/route.ts` | NextAuth catch-all handler (GET+POST) |
| `docs/route.ts` | `GET` list docs (with filters); `POST` load sync from Drive (accepts selectedGoogleDocIds, labelIds, notes) |
| `docs/gmail-refresh/route.ts` | `POST` incremental Gmail refresh — scans Gmail since last timestamp, performs upsert and sync via shared logic in `refresh.ts` |
| `docs/gmail-refresh/route.test.ts` | Tests for incremental Gmail refresh flow, deletion detection, and timestamp updates |
| `docs/refresh/route.ts` | `POST` refresh — discovery mode (`{ sources }`), full mode (`{ mode: "full" }`), or selected mode (`{ docIds }`); delegates to `executeRefresh` in `refresh.ts` |
| `docs/refresh/route.test.ts` | Tests for discovery and full refresh modes |
| `docs/scan/route.ts` | `POST` scan Drive or Gmail for documents without modifying DB — branches on `source` field, returns total, existing count, and new doc list |
| `docs/add/route.ts` | `POST` add or update a doc by URL — existing docs (any access state) get labels/notes/status/star updated; new docs delegate to shared `addDoc()` in `add-doc.ts` |
| `docs/validate/route.ts` | `GET` validate a Google Drive URL — checks access, mime type, returns metadata; for existing docs returns `existing: true` with labels, notes, status, star |
| `docs/bulk-update/route.ts` | `PATCH` bulk update multiple docs — optimized role/star/label/notes updates with no-op protection |
| `docs/[docId]/route.ts` | `GET` single doc; `PATCH` update role/status/star/labels |
| `docs/[docId]/re-add/route.ts` | `POST` delete and re-add document — validates ownership, delegates to shared `addDoc()` with `deleteDocId`; handles permission-denied via fallback metadata |
| `docs/[docId]/refresh/route.ts` | `POST` refresh single doc — updates Drive metadata and syncs comments via shared logic in `refresh.ts` |
| `docs/[docId]/refresh/route.test.ts` | Tests for single-doc metadata refresh and comment sync |
| `docs/sync-comments/[googleDocId]/route.ts` | `POST` sync comments+suggestions for a single doc by Google doc ID — called by Chrome extension when comment activity is detected on a Google Docs page |
| `docs/[docId]/comments/route.ts` | `PATCH` bulk update comment status or isRead |
| `docs/[docId]/content/route.ts` | `GET` fetch document text and suggestion content (slow path — Docs API `documents.get` or Drive `files.export`); for Docs, uses a single `SUGGESTIONS_INLINE` call for both |
| `docs/[docId]/comments/[commentId]/route.ts` | `PATCH` update a comment's status (INBOX/ARCHIVED/MUTED), read state, or star |
| `docs/[docId]/threads/route.ts` | `GET` fetch threads from Drive (all with `viewedByMeTime`, single, or checkOnly); `POST` refresh a single thread (updates DB) |
| `docs/metadata/route.ts` | `POST` fetch current doc titles and owners from Google Drive for given IDs — used by client-side metadata cache for stale/missing entries |
| `docs/[docId]/threads/reply/route.ts` | `POST` reply to / resolve / reopen a comment thread via Drive API; pins `viewedByMeTime` around the action (debug logging) |
| `docs/[docId]/viewed-time/route.ts` | `PUT` update `viewedByMeTime` on a Google Drive file |
| `labels/route.ts` | `GET` list labels with document counts; `POST` create label |
| `labels/[labelId]/route.ts` | `GET` single label with document count; `PATCH` update label color; `DELETE` delete label |
| `labels/reorder/route.ts` | `PATCH` reorder labels by position |
| `user/delete-all-data/route.ts` | `DELETE` delete all user data — optionally deletes account (cascade) or just app data (docs, labels, status) |
| `help-seen/route.ts` | `POST` mark help as seen — upserts `hasSeenHelp: true` on Status table |

## Components (`src/components/`)

| File | Description |
|------|-------------|
| `doc-table.tsx` | Main doc list view (client) — filter state, sort state, renders FilterBar + DocRows |
| `auto-signin.tsx` | Client component for seamless offline authentication |
| `google-signin-button.tsx` | Google OAuth sign-in button with branded styling |
| `doc-row.tsx` | Single doc row in the table — star, title, comment counts, labels, archive/edit/open buttons |
| `doc-detail.tsx` | Single doc detail view (client) — metadata panel, comment filters, comment table; pre-fetches all threads on load for instant expand |
| `filter-bar.tsx` | Doc list filter bar — tri-state buttons for type/author/starred/labels/active/comments + title regex |
| `comment-filter-bar.tsx` | Comment list filter bar — toggles for my threads/comments, starred, show mode, suggestions, unread |
| `comment-row.tsx` | Single comment row — expandable, shows content preview, thread panel, status actions |
| `comment-thread-panel.tsx` | Expanded thread view — shows all replies, reply textarea, resolve/reopen buttons |
| `add-doc-form.tsx` | Shared add/update/re-add doc form body — URL validation (Add mode) or fixed doc (Re-add mode), label picker, notes; used by dialogs and standalone page |
| `add-doc-dialog.tsx` | Dialog wrapper for adding/updating a doc — renders `add-doc-form` inside a dialog, dynamic title and button text |
| `add-doc-page-client.tsx` | Standalone add/update doc page (client) — renders `add-doc-form` in a card with cross-tab sync |
| `edit-doc-dialog.tsx` | Dialog to edit doc role, star, and labels |
| `delete-readd-dialog.tsx` | Dialog to delete a document and re-add it as fresh |
| `bulk-edit-dialog.tsx` | Dialog to edit role, star, labels, and notes for multiple documents simultaneously; supports multi-select highlighting to scope actions to a subset |
| `delete-all-dialog.tsx` | Two-step confirmation dialog for deleting all user data — first confirms intent, then offers "Delete and log out" vs "Delete data only" |

| `load-dialog.tsx` | Load from Drive/Gmail dialog — two-phase scan→add flow with source toggle (Drive/Gmail), options (days back, ownership, shared drives), doc selection with multi-select highlighting, labels, notes; shows error count for unresolved Gmail emails |
| `refresh-button.tsx` | Combined Refresh button — calls POST `/api/docs/refresh` with both Drive+Gmail sources, then reloads list |
| `star-button.tsx` | `StarButton` (two-state toggle) and `TriStateStarButton` (tri-state filter) for starring docs and comments |
| `tri-state-button.tsx` | Tri-state filter buttons (off/include/exclude) with diagonal strikethrough + slow-click-to-reset; exports `useTriStateCycle` and `DiagonalStrike` |
| `label-badge.tsx` | Colored label pill with optional remove button |
| `label-picker.tsx` | Label selection grid for add/edit dialogs |
| `manage-labels-dialog.tsx` | Dialog to create/delete/reorder/recolor labels with pointer-based drag reorder; includes delete confirmation with usage count and hover tooltips |
| `color-picker.tsx` | Popover color grid for label color selection |
| `dialog-buttons.tsx` | Reusable Save/Cancel button pair for dialogs |
| `friendly-date.tsx` | `<FriendlyDate>` — renders relative timestamps: time-only (today), weekday + time (<6d), date (older); full timestamp on hover |
| `doc-type-icon.tsx` | SVG icons for Google Docs/Sheets/Slides by mime type |
| `x-icon.tsx` | Small X (close) icon used in badges and buttons |
| `help-dialog.tsx` | Multi-page help viewer dialog — iframe + pages.json navigation, keyboard shortcuts, page dropdown |
| `welcome-dialog.tsx` | First-login welcome dialog — single Quick Start page in iframe, marks `hasSeenHelp` on close |

### UI primitives (`src/components/ui/`)

Shadcn/ui components:

| File | Description |
|------|-------------|
| `alert-dialog.tsx` | Alert dialog for confirmations (Radix) |
| `button.tsx` | Button component with variant/size props |
| `checkbox.tsx` | Checkbox input |
| `dialog.tsx` | Modal dialog (Radix) |
| `dropdown-menu.tsx` | Dropdown menu (Radix) |
| `popover.tsx` | Popover (Radix) |
| `select.tsx` | Select dropdown (Radix) |
| `sonner.tsx` | Toast notifications (Sonner) |

## Hooks (`src/hooks/`)

| File | Description |
|------|-------------|
| `use-auto-resize.ts` | `useAutoResize()` hook — auto-grows a textarea to fit content up to a max height |
| `use-label-sync.ts` | `useLabelSync()` hook — removes stale label IDs from selection when available labels change |
| `use-cached-metadata.ts` | `useCachedMetadata()` hook — manages localStorage cache of doc metadata (titles + owners) with staleness detection via `lastModifiedInDrive`, async fetch for stale/missing entries |
| `use-multi-select.ts` | `useMultiSelect()` hook — generic row multi-selection with click/Ctrl+click/Shift+click, highlight state, effective item filtering, and bulk removal helpers |

## Scripts (`scripts/`)

| File | Description |
|------|-------------|
| `check-deps.mjs` | Checks that required Node.js version and dependencies are installed |
| `check-db.mjs` | Checks that the database is reachable and migrations are up-to-date |
| `query_database.sh` | Readonly SQL queries via `docreview_ro` user — supports inline SQL, file input, `--schema` |

## Contexts (`src/contexts/`)

| File | Description |
|------|-------------|
| `label-context.tsx` | `LabelProvider` + `useLabels()` — React context for label state, replacing prop drilling |

## Library (`src/lib/`)

| File | Description |
|------|-------------|
| `add-doc.ts` | Shared `addDoc()` for add and re-add routes — Drive metadata fetch with permission-denied fallback, transactional delete+create, comment sync; also exports `validateLabelOwnership()` and `validateDocInputs()` used across multiple routes |
| `api-fetch.ts` | Client-side `apiFetch()` wrapper — intercepts 401 (expired Google token), shows deduplicated reauth toast, throws `ApiAuthError`; `isAuthError()` helper for catch blocks |
| `google-drive.ts` | Google Drive/Docs API client — OAuth2 with token refresh, `invalidGrantResponse()` for API routes, changes feed (`changes.list`/`getStartPageToken`), file listing, `fetchDocsByIds` (batch metadata fetch by ID), comment fetching, `fetchAllThreads` (bulk thread fetch), `fetchSuggestions` (suggestion IDs + text content from Docs API), `fetchDocContent` (combined document text + suggestion extraction in one Docs API call), thread detail, reply/resolve; OAuth2 client also used by Gmail scanner |
| `gmail.ts` | Gmail notification scanner — `scanGmailForDocIds(userId, since)` queries Gmail for doc sharing/comment emails after a `Date`, extracts doc IDs and share notes from body (no Drive calls); `scanGmailNotifications` wraps it with Drive metadata fetch; filters by `internalDate` for timestamp-level precision |
| `gmail-parse.ts` | Gmail message parsing helpers — `parseShareNote` extracts sharer name/email/date/message from share notification emails; `extractShareMessage` structurally parses plaintext body (language-independent); `extractBodyText` decodes MIME payload; `extractDocId` finds doc IDs in email text |
| `refresh.ts` | Combined refresh engine — `executeRefresh(userId, email, sources)` runs parallel Drive+Gmail discovery; `executeFullRefresh(userId, email)` and `refreshSelectedDocs(userId, email, docIds)` run exhaustive syncs via shared `refreshGoogleDocIds` helper |
| `auth-utils.ts` | Centralized authentication helpers for Server Components and API routes |
| `sync-comments.ts` | Comment sync engine — full-scan of Drive comments + Docs suggestions, creates/updates/deletes DB records, computes unarchive signals, stores suggestion content hashes; falls back to content hash lookup for Gmail-first suggestion rows |
| `suggestion-hash.ts` | Content hash for suggestions — SHA-256 of normalized action type + deleted/inserted text, used for cross-source matching (Docs API ↔ Gmail) |
| `suggestion-merge.ts` | Merges suggestion data from Gmail notifications into DB — matches by content hash, fills in `googleCommentId` and `replyCount`, or inserts new rows if Gmail arrives first |
| `bridge-to-extension.ts` | Client-side bridge for communicating with the Chrome extension — handles pinging, URL resolution, in-page comment navigation, and fetching suggestion data from open doc tabs |
| `extension-suggestions.ts` | Converts extension-scraped suggestion data into display objects — timestamp parsing, CommentThread/SuggestionContent creation for thread panel display |
| `extension-suggestion-merge.ts` | Server-side merge of extension suggestions into DB — content-hash matching (same algorithm as Gmail merge), inserts or updates suggestion records with disco IDs and author data |
| `cross-tab.ts` | Cross-tab state sync via BroadcastChannel — lightweight event types, `broadcastChange()`, `useCrossTabListener()` hook |
| `doc-filters.ts` | Client-side doc filtering (tri-state logic for inbox/comments/author/starred/mimeType/labels/title regex) and sorting; accepts optional cached titles map for when `doc.title` is empty |
| `browser-cache.ts` | Generic localStorage cache — namespaced key-value store with JSON values, batch operations, and staleness-based eviction |
| `doc-queries.ts` | Shared Prisma include constants (`labelInclude`, `docWithCountsInclude`, `docWithCommentsInclude`) + `withCommentCounts` transform + `stripServerOnly` (strips titles from API responses for privacy) |
| `highlight.tsx` | `highlightText()` — regex/substring highlighter for plain text; `highlightHtml()` — same for HTML strings (highlights text outside tags, returns null if no match); `matchesFilter()` — centralized dual regex/substring search; `createMatcher()` — compiled reusable matcher |
| `prisma.ts` | Singleton PrismaClient with dev-mode write-op logging and base64 field obscuring |
| `prisma-obscure.ts` | Prisma client extension that base64-encodes/decodes Doc.title, Doc.notes, Label.name transparently |
| `bulk-edit.ts` | `BulkEditState` type and `cycleBulkEditState` helper for multi-doc editing |
| `env-config.ts` | Client-accessible environment config — `CHROME_EXTENSION_URL` with env var override |
| `tab-targets.ts` | Named window targets for tab reuse — `commentsTarget()`, `docTarget()`, `openCommentsPage()`, `openDocPage()` |
| `offline.ts` | Offline mode constants — `OFFLINE_MODE` flag, `OfflineModeError`, fallback user |
| `role-colors.ts` | Tailwind class maps for Author (blue) and Reviewer (violet) role badges/filters |
| `load-options.ts` | `parseLoadOptions()` — shared validation for scan/load request body (daysBack, ownership, includeSharedDrives, source) |
| `log.ts` | `logError()`, `logWarning()`, and `logInfo()` — centralized logging helpers; console output (colored) + daily file output to `logs/` with timestamps and request IDs |
| `parse-gmail-notification.ts` | Gmail notification parser — extracts structured data from raw `.eml` content for comment and sharing notifications |
| `progress-events.ts` | Shared progress event types (`ProgressEvent`, `OnProgress`) used by SSE server (sse.ts) and client (stream-progress.ts) |
| `promise-utils.ts` | `withProgressLogging()` — wraps promises with periodic log messages for long-running operations |
| `request-context.ts` | `runWithRequestId(method, req, fn)` and `getRequestId()` — AsyncLocalStorage-based request ID context for correlating log lines across a single API request; extracts URL and client context ID from request; logs `[API] METHOD /path` silently on entry |
| `sse.ts` | Server-side SSE (Server-Sent Events) streaming — `createProgressStream()` wraps long-running API operations, sends progress/result/error events over a ReadableStream |
| `status.ts` | Read/write `Status` table — tracks `driveChangesPageToken` and `lastGmailUpdateTimestamp` per user for incremental sync |
| `stream-progress.ts` | Client-side SSE reader + toast handlers — `fetchWithProgress()` reads SSE streams, `handleRefreshProgress()` maps events to Sonner toasts, `formatResultParts()` formats result summaries |
| `textarea-styles.ts` | Shared Tailwind classes for consistent textarea styling |
| `tooltips.ts` | Shared tooltip text constants for UI components |
| `tri-state.ts` | `TriState` type (`off`/`include`/`exclude`), cycle function, partition helper |
| `url-utils.ts` | `isPublicShortenerUrl()` — server-side redirect whitelist (bit.ly, tinyurl.com, t.co) |
| `utils.ts` | `cn()` (clsx+twMerge), `contrastText()` for label colors, `formatDate()` (full timestamp for logging), `formatDateFriendly()` (relative display format), `appendNotes()` (append text to existing notes with newline separator) |
| `__mocks__/prisma.ts` | Vitest mock of PrismaClient for unit tests |

## Types (`src/types/`)

| File | Description |
|------|-------------|
| `index.ts` | `DocWithLabels`, `DocWithComments`, `LabelWithCount` types + NextAuth session augmentation |

## Schema & Config

| File | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema — User, Account, Session, Doc, Comment, Label, DocLabel, Status + enums |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `api-routes.md` | API route reference — every endpoint, what it does, Google API vs Prisma-only, comparison tables for similar endpoints |
| `architecture.md` | High-level system architecture — tech stack, data model, API layer, client/server split, security |
| `auth.md` | Authentication — NextAuth v5 + Google OAuth, session handling, token refresh |
| `bulk-edit.md` | Bulk editing logic — tri-state UI, context-aware cycling, no-op protection |
| `chrome-extension.md` | Chrome extension design — file descriptions, app integration, comment navigation implementation, content script isolation, dynamic registration |
| `comment-tracking.md` | Comment status logic, unarchive rules, filter behavior |
| `cross-tab.md` | Cross-tab sync — BroadcastChannel events, deduplication, listener hook |
| `dialog-sizing.md` | Shared dialog sizing pattern — flexible item list, stable height on removal |
| `file-index.md` | This file — one-line descriptions of every source file |
| `gmail.md` | Gmail integration — scanner internals, combined refresh engine, timestamp lifecycle, Load vs Refresh comparison |
| `inbox-states.md` | Describes Inbox/Archived/Muted states for docs and comments, and state changes between them |
| `local-storage-cache.md` | Browser localStorage cache — motivation, privacy model, key/value format, staleness detection, eviction, future plans |
| `load-dialog.md` | Load dialog — two-phase scan→add flow, Drive/Gmail source toggle, search options, dialog layout |
| `notes-on-dom-snapshot-testing.md` | DOM snapshot testing for content script development — saving/loading snapshots, known issues, next steps |
| `refresh.md` | Full refresh flow — Drive sync modes, deletion detection, comment sync, UI update |
| `suggestions.md` | Suggestion sync via Docs API, limitations |

## Testing (`testing/`)

| File | Description |
|------|-------------|
| `README.md` | How to run and maintain the Chrome extension content script tests |
| `chrome-extension.md` | Chrome extension test cases — content script injection, idempotency, toolbar button, adapted from former bookmarklet tests |
| `content-script.spec.ts` | Playwright tests for content script DOM injection against saved snapshots |
| `playwright.config.ts` | Playwright config — system Chrome, snapshot HTTP server |
| `snapshots/` | Saved rendered DOM from live Google pages (Docs, Sheets, Slides, Drive, Gmail) — gitignored |
| `gmail_notifications/` | `.eml` + `.json` pairs for testing `parse-gmail-notification.ts` — comment notifications, sharing invitations, suggestions, edge cases |

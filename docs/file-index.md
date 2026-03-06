# File Index

One-line descriptions of every source file, grouped by layer.

## Pages (`src/app/`)

| File | Description |
|------|-------------|
| `page.tsx` | Root redirect — sends authed users to `/docs`, others to `/login` |
| `layout.tsx` | Root layout — Geist fonts, global CSS, Sonner toaster |
| `login/page.tsx` | Login page — Google OAuth button, or offline-mode button |
| `docs/page.tsx` | Doc list page (server) — fetches docs+labels, renders `DocTable` |
| `add/page.tsx` | Add document page (server) — standalone add-doc form, accepts optional `?doc=` query param |
| `open/page.tsx` | Open page (server) — redirects to `/comments/<docId>` if doc exists, otherwise to `/add?doc=...` |
| `comments/[docId]/page.tsx` | Doc detail page (server) — fetches single doc with comments, renders `DocDetail`; `generateMetadata` sets page title |

## API Routes (`src/app/api/`)

| File | Description |
|------|-------------|
| `auth/[...nextauth]/route.ts` | NextAuth catch-all handler (GET+POST) |
| `docs/route.ts` | `GET` list docs (with filters); `POST` refresh/full-refresh/load sync from Drive (load accepts selectedGoogleDocIds, labelIds, notes) |
| `docs/gmail-refresh/route.ts` | `POST` incremental Gmail refresh — scans Gmail since last timestamp, upserts docs, syncs comments, unarchives ARCHIVED docs with new activity, detects deletions (legacy; superseded by `/api/docs/refresh`) |
| `docs/refresh-selected/route.ts` | `POST` refresh metadata and comments for a specific set of documents (no Drive/Gmail scan) |
| `docs/refresh/route.ts` | `POST` combined refresh — accepts `{ sources: ["drive", "gmail"] }`, runs parallel discovery, merges results, upserts, syncs comments; defaults to both sources |
| `docs/scan/route.ts` | `POST` scan Drive or Gmail for documents without modifying DB — branches on `source` field, returns total, existing count, and new doc list |
| `docs/add/route.ts` | `POST` add or update a doc by URL — validates via Drive; creates DB record + syncs comments for new docs, updates labels/notes/status/star for existing docs |
| `docs/validate/route.ts` | `GET` validate a Google Drive URL — checks access, mime type, returns metadata; for existing docs returns `existing: true` with labels, notes, status, star |
| `docs/bulk-update/route.ts` | `PATCH` bulk update multiple docs — optimized role/star/label/notes updates with no-op protection |
| `docs/[docId]/route.ts` | `GET` single doc; `PATCH` update role/status/star/labels |
| `docs/[docId]/refresh/route.ts` | `POST` refresh single doc — updates Drive metadata then syncs comments |
| `docs/[docId]/comments/route.ts` | `GET` fetch all comment threads from Drive (fast path — Drive `comments.list` only) |
| `docs/[docId]/content/route.ts` | `GET` fetch document text and suggestion content (slow path — Docs API `documents.get` or Drive `files.export`); for Docs, uses a single `SUGGESTIONS_INLINE` call for both |
| `docs/[docId]/comments/[commentId]/route.ts` | `PATCH` update a comment's status (INBOX/ARCHIVED/MUTED), read state, or star |
| `docs/[docId]/threads/route.ts` | `GET` fetch thread(s) from Drive; `POST` refresh a single thread (updates DB) |
| `docs/[docId]/threads/reply/route.ts` | `POST` reply to / resolve / reopen a comment thread via Drive API |
| `labels/route.ts` | `GET` list labels with document counts; `POST` create label |
| `labels/[labelId]/route.ts` | `GET` single label with document count; `PATCH` update label color; `DELETE` delete label |
| `labels/reorder/route.ts` | `PATCH` reorder labels by position |

## Components (`src/components/`)

| File | Description |
|------|-------------|
| `doc-table.tsx` | Main doc list view (client) — filter state, sort state, renders FilterBar + DocRows |
| `auto-signin.tsx` | Client component for seamless offline authentication |
| `doc-row.tsx` | Single doc row in the table — star, title, comment counts, labels, archive/edit/open buttons |
| `doc-detail.tsx` | Single doc detail view (client) — metadata panel, comment filters, comment table; pre-fetches all threads on load for instant expand |
| `filter-bar.tsx` | Doc list filter bar — tri-state buttons for type/author/starred/labels/active/comments + title regex |
| `comment-filter-bar.tsx` | Comment list filter bar — toggles for my threads/comments, starred, show mode, suggestions, unread |
| `comment-row.tsx` | Single comment row — expandable, shows content preview, thread panel, status actions |
| `comment-thread-panel.tsx` | Expanded thread view — shows all replies, reply textarea, resolve/reopen buttons |
| `add-doc-content.tsx` | Shared add/update doc form body — URL validation, label picker, notes; populates form from existing doc data; used by dialog and standalone page |
| `add-doc-dialog.tsx` | Dialog wrapper for adding/updating a doc — renders `AddDocContent` inside a dialog, dynamic title and button text |
| `add-doc-page-client.tsx` | Standalone add/update doc page (client) — renders `AddDocContent` in a card with cross-tab sync |
| `edit-doc-dialog.tsx` | Dialog to edit doc role, star, and labels |
| `bulk-edit-dialog.tsx` | Dialog to edit role, star, labels, and notes for multiple documents simultaneously; supports multi-select highlighting to scope actions to a subset |

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

### UI primitives (`src/components/ui/`)

Shadcn/ui components:

| File | Description |
|------|-------------|
| `alert-dialog.tsx` | Alert dialog for confirmations (Radix) |
| `badge.tsx` | Badge component |
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
| `use-multi-select.ts` | `useMultiSelect()` hook — generic row multi-selection with click/Ctrl+click/Shift+click, highlight state, effective item filtering, and bulk removal helpers |

## Contexts (`src/contexts/`)

| File | Description |
|------|-------------|
| `label-context.tsx` | `LabelProvider` + `useLabels()` — React context for label state, replacing prop drilling |

## Library (`src/lib/`)

| File | Description |
|------|-------------|
| `api-fetch.ts` | Client-side `apiFetch()` wrapper — intercepts 401 (expired Google token), shows deduplicated reauth toast, throws `ApiAuthError`; `isAuthError()` helper for catch blocks |
| `google-drive.ts` | Google Drive/Docs API client — OAuth2 with token refresh, `invalidGrantResponse()` for API routes, changes feed (`changes.list`/`getStartPageToken`), file listing, `fetchDocsByIds` (batch metadata fetch by ID), comment fetching, `fetchAllThreads` (bulk thread fetch), `fetchDocContent` (combined document text + suggestion extraction in one Docs API call), thread detail, reply/resolve; OAuth2 client also used by Gmail scanner |
| `gmail.ts` | Gmail notification scanner — `scanGmailForDocIds(userId, since)` queries Gmail for doc sharing/comment emails after a `Date`, extracts doc IDs from body (no Drive calls); `scanGmailNotifications` wraps it with Drive metadata fetch; filters by `internalDate` for timestamp-level precision |
| `refresh.ts` | Combined refresh engine — `executeRefresh(userId, email, sources)` runs parallel Drive+Gmail discovery, merges results; `refreshSelectedDocs(userId, email, docIds)` handles targeted refreshes; both use shared `upsertDocsAndSyncComments` helper |
| `auth-utils.ts` | Centralized authentication helpers for Server Components and API routes |
| `sync-comments.ts` | Comment sync engine — full-scan of Drive comments + Docs suggestions, creates/updates/deletes DB records, computes unarchive signals |
| `cross-tab.ts` | Cross-tab state sync via BroadcastChannel — lightweight event types, `broadcastChange()`, `useCrossTabListener()` hook |
| `doc-filters.ts` | Client-side doc filtering (tri-state logic for inbox/comments/author/starred/mimeType/labels/title regex) and sorting |
| `doc-queries.ts` | Shared Prisma include constants (`labelInclude`, `docWithCountsInclude`, `docWithCommentsInclude`) + `withCommentCounts` transform |
| `highlight.tsx` | `highlightText()` — regex/substring highlighter for plain text; `highlightHtml()` — same for HTML strings (highlights text outside tags, returns null if no match); `matchesFilter()` — centralized dual regex/substring search; `createMatcher()` — compiled reusable matcher |
| `prisma.ts` | Singleton PrismaClient with dev-mode write-op logging |
| `bulk-edit.ts` | `BulkEditState` type and `cycleBulkEditState` helper for multi-doc editing |
| `offline.ts` | Offline mode constants — `OFFLINE_MODE` flag, `OfflineModeError`, fallback user |
| `role-colors.ts` | Tailwind class maps for Author (blue) and Reviewer (violet) role badges/filters |
| `load-options.ts` | `parseLoadOptions()` — shared validation for scan/load request body (daysBack, ownership, includeSharedDrives, source) |
| `log.ts` | `logError()`, `logWarning()`, and `logInfo()` — centralized logging helpers; console output (colored) + daily file output to `logs/` with timestamps and request IDs |
| `request-context.ts` | `runWithRequestId(method, req, fn)` and `getRequestId()` — AsyncLocalStorage-based request ID context for correlating log lines across a single API request; extracts URL and client context ID from request; logs `[API] METHOD /path` silently on entry |
| `status.ts` | Read/write `Status` table — tracks `driveChangesPageToken` and `lastGmailUpdateTimestamp` per user for incremental sync |
| `tri-state.ts` | `TriState` type (`off`/`include`/`exclude`), cycle function, partition helper |
| `utils.ts` | `cn()` (clsx+twMerge), `contrastText()` for label colors, `formatDate()` (full timestamp for logging), `formatDateFriendly()` (relative display format) |
| `__mocks__/prisma.ts` | Vitest mock of PrismaClient for unit tests |

## Types & Test Utilities

| File | Description |
|------|-------------|
| `types/index.ts` | `DocWithLabels`, `DocWithComments`, `LabelWithCount` types + NextAuth session augmentation |
| `test-utils.ts` | `suppressingErrors()` — wraps test blocks to suppress expected console.error output |

## Schema & Config

| File | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema — User, Account, Session, Doc, Comment, Label, DocLabel, Status + enums |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `auth.md` | Authentication — NextAuth v5 + Google OAuth, session handling, token refresh |
| `bulk-edit.md` | Bulk editing logic — tri-state UI, context-aware cycling, no-op protection |
| `comment-tracking.md` | Comment status logic, unarchive rules, filter behavior |
| `cross-tab.md` | Cross-tab sync — BroadcastChannel events, deduplication, listener hook |
| `dialog-sizing.md` | Shared dialog sizing pattern — flexible item list, stable height on removal |
| `file-index.md` | This file — one-line descriptions of every source file |
| `gmail.md` | Gmail integration — scanner internals, combined refresh engine, timestamp lifecycle, Load vs Refresh comparison |
| `inbox-states.md` | Describes Inbox/Archived/Muted states for docs and comments, and state changes between them |
| `load-dialog.md` | Load dialog — two-phase scan→add flow, Drive/Gmail source toggle, search options, dialog layout |
| `refresh.md` | Full refresh flow — Drive sync modes, deletion detection, comment sync, UI update |
| `suggestions.md` | Suggestion sync via Docs API, limitations |

# File Index

One-line descriptions of every source file, grouped by layer.

## Pages (`src/app/`)

| File | Description |
|------|-------------|
| `page.tsx` | Root redirect — sends authed users to `/docs`, others to `/login` |
| `layout.tsx` | Root layout — Geist fonts, global CSS, Sonner toaster |
| `login/page.tsx` | Login page — Google OAuth button, or offline-mode button |
| `docs/page.tsx` | Doc list page (server) — fetches docs+labels, renders `DocTable` |
| `add/page.tsx` | Add document page (server) — standalone add-doc form, accepts optional `?url=` query param |
| `comments/[id]/page.tsx` | Doc detail page (server) — fetches single doc with comments, renders `DocDetail`; `generateMetadata` sets page title |

## API Routes (`src/app/api/`)

| File | Description |
|------|-------------|
| `auth/[...nextauth]/route.ts` | NextAuth catch-all handler (GET+POST) |
| `docs/route.ts` | `GET` list docs (with filters); `POST` refresh/full-refresh/load sync from Drive (load accepts selectedGoogleDocIds, labelIds, notes) |
| `docs/scan/route.ts` | `POST` scan Drive for documents without modifying DB — returns total, existing count, and new doc list |
| `docs/add/route.ts` | `POST` add a doc by URL — validates via Drive, creates DB record, syncs comments |
| `docs/validate/route.ts` | `GET` validate a Google Drive URL — checks access, mime type, returns metadata |
| `docs/bulk-update/route.ts` | `PATCH` bulk update multiple docs — optimized role/label/notes updates with no-op protection |
| `docs/[id]/route.ts` | `GET` single doc; `PATCH` update role/status/labels |
| `docs/[id]/refresh/route.ts` | `POST` refresh single doc — updates Drive metadata then syncs comments |
| `docs/[id]/comments/route.ts` | `GET` fetch all comment threads from Drive (fast path — Drive `comments.list` only) |
| `docs/[id]/content/route.ts` | `GET` fetch document text and suggestion content (slow path — Docs API `documents.get` or Drive `files.export`); for Docs, uses a single `SUGGESTIONS_INLINE` call for both |
| `docs/[id]/comments/[commentId]/route.ts` | `PATCH` update a comment's status (ACTIVE/ARCHIVED/MUTED) |
| `docs/[id]/threads/route.ts` | `GET` fetch thread(s) from Drive; `POST` refresh a single thread (updates DB) |
| `docs/[id]/threads/reply/route.ts` | `POST` reply to / resolve / reopen a comment thread via Drive API |
| `labels/route.ts` | `GET` list labels; `POST` create label |
| `labels/[id]/route.ts` | `PATCH` update label color; `DELETE` delete label |
| `labels/reorder/route.ts` | `PATCH` reorder labels by position |

## Components (`src/components/`)

| File | Description |
|------|-------------|
| `doc-table.tsx` | Main doc list view (client) — filter state, sort state, renders FilterBar + DocRows |
| `auto-signin.tsx` | Client component for seamless offline authentication |
| `doc-row.tsx` | Single doc row in the table — title, comment counts, labels, archive/edit/open buttons |
| `doc-detail.tsx` | Single doc detail view (client) — metadata panel, comment filters, comment table; pre-fetches all threads on load for instant expand |
| `filter-bar.tsx` | Doc list filter bar — tri-state buttons for type/author/labels/active/comments + title regex |
| `comment-filter-bar.tsx` | Comment list filter bar — toggles for my threads/comments, show mode, suggestions |
| `comment-row.tsx` | Single comment row — expandable, shows content preview, thread panel, status actions |
| `comment-thread-panel.tsx` | Expanded thread view — shows all replies, reply textarea, resolve/reopen buttons |
| `add-doc-content.tsx` | Shared add-doc form body — URL validation, label picker, notes; used by dialog and standalone page |
| `add-doc-dialog.tsx` | Dialog wrapper for adding a doc — renders `AddDocContent` inside a dialog |
| `add-doc-page-client.tsx` | Standalone add-doc page (client) — renders `AddDocContent` in a card with cross-tab sync |
| `edit-doc-dialog.tsx` | Dialog to edit doc role and labels |
| `bulk-edit-dialog.tsx` | Dialog to edit role, labels, and notes for multiple documents simultaneously |

| `load-dialog.tsx` | Load from Drive dialog — two-phase scan→add flow with options (days back, ownership, shared drives), doc selection, labels, notes |
| `refresh-button.tsx` | Refresh/Full Refresh button — calls POST `/api/docs` then reloads list |
| `tri-state-button.tsx` | Tri-state filter buttons (off/include/exclude) with diagonal strikethrough + slow-click-to-reset |
| `label-badge.tsx` | Colored label pill with optional remove button |
| `label-picker.tsx` | Label selection grid for add/edit dialogs |
| `manage-labels-dialog.tsx` | Dialog to create/delete/reorder/recolor labels with pointer-based drag reorder |
| `color-picker.tsx` | Popover color grid for label color selection |
| `dialog-buttons.tsx` | Reusable Save/Cancel button pair for dialogs |
| `doc-type-icon.tsx` | SVG icons for Google Docs/Sheets/Slides by mime type |

### UI primitives (`src/components/ui/`)

Shadcn/ui components: `badge.tsx`, `button.tsx`, `checkbox.tsx`, `dialog.tsx`, `popover.tsx`, `select.tsx`, `sonner.tsx`

## Hooks (`src/hooks/`)

| File | Description |
|------|-------------|
| `use-auto-resize.ts` | `useAutoResize()` hook — auto-grows a textarea to fit content up to a max height |
| `use-label-sync.ts` | `useLabelSync()` hook — removes stale label IDs from selection when available labels change |

## Contexts (`src/contexts/`)

| File | Description |
|------|-------------|
| `label-context.tsx` | `LabelProvider` + `useLabels()` — React context for label state, replacing prop drilling |

## Library (`src/lib/`)

| File | Description |
|------|-------------|
| `api-fetch.ts` | Client-side `apiFetch()` wrapper — intercepts 401 (expired Google token), shows deduplicated reauth toast, throws `ApiAuthError`; `isAuthError()` helper for catch blocks |
| `google-drive.ts` | Google Drive/Docs API client — OAuth2 with token refresh, `invalidGrantResponse()` for API routes, changes feed (`changes.list`/`getStartPageToken`), file listing, comment fetching, `fetchAllThreads` (bulk thread fetch), `fetchDocContent` (combined document text + suggestion extraction in one Docs API call), thread detail, reply/resolve |
| `auth-utils.ts` | Centralized authentication helpers for Server Components and API routes |
| `sync-comments.ts` | Comment sync engine — full-scan of Drive comments + Docs suggestions, creates/updates/deletes DB records, computes unarchive signals |
| `cross-tab.ts` | Cross-tab state sync via BroadcastChannel — lightweight event types, `broadcastChange()`, `useCrossTabListener()` hook |
| `doc-filters.ts` | Client-side doc filtering (tri-state logic for active/comments/author/mimeType/labels/title regex) and sorting |
| `doc-queries.ts` | Shared Prisma include constants (`labelInclude`, `docWithCountsInclude`, `docWithCommentsInclude`) + `withCommentCounts` transform |
| `highlight.tsx` | `highlightText()` — regex/substring highlighter for plain text; `highlightHtml()` — same for HTML strings (highlights text outside tags, returns null if no match); `matchesFilter()` — centralized dual regex/substring search; `createMatcher()` — compiled reusable matcher |
| `prisma.ts` | Singleton PrismaClient with dev-mode write-op logging |
| `bulk-edit.ts` | `BulkEditState` type and `cycleBulkEditState` helper for multi-doc editing |
| `offline.ts` | Offline mode constants — `OFFLINE_MODE` flag, `OfflineModeError`, fallback user |
| `role-colors.ts` | Tailwind class maps for Author (blue) and Reviewer (violet) role badges/filters |
| `load-options.ts` | `parseLoadOptions()` — shared validation for scan/load request body (daysBack, ownership, includeSharedDrives) |
| `status.ts` | Read/write `Status` table — tracks `driveChangesPageToken` per user for incremental sync via Drive Changes API |
| `tri-state.ts` | `TriState` type (`off`/`include`/`exclude`), cycle function, partition helper |
| `utils.ts` | `cn()` (clsx+twMerge), `contrastText()` for label colors, `formatDate()` |
| `__mocks__/prisma.ts` | Vitest mock of PrismaClient for unit tests |

## Types & Test Utilities

| File | Description |
|------|-------------|
| `types/index.ts` | `DocWithLabels`, `DocWithComments` types + NextAuth session augmentation |
| `test-utils.ts` | `suppressingErrors()` — wraps test blocks to suppress expected console.error output |

## Schema & Config

| File | Description |
|------|-------------|
| `prisma/schema.prisma` | Database schema — User, Account, Session, Doc, Comment, Label, DocLabel, Status + enums |

## Design Docs (`docs/`)

| File | Description |
|------|-------------|
| `refresh.md` | Full refresh flow — Drive sync modes, deletion detection, comment sync, UI update |
| `comment-tracking.md` | Comment status logic, unarchive rules, filter behavior |
| `bulk-edit.md` | Bulk editing logic — tri-state UI, context-aware cycling, no-op protection |
| `dialog-sizing.md` | Shared dialog sizing pattern — flexible item list, stable height on removal |
| `load-dialog.md` | Load dialog — two-phase scan→add flow, search options, dialog layout |
| `suggestions.md` | Suggestion sync via Docs API, limitations |

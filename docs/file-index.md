# File Index

One-line descriptions of every source file, grouped by layer.

## Pages (`src/app/`)

| File | Description |
|------|-------------|
| `page.tsx` | Root redirect — sends authed users to `/docs`, others to `/login` |
| `layout.tsx` | Root layout — Geist fonts, global CSS, Sonner toaster |
| `login/page.tsx` | Login page — Google OAuth button, or offline-mode button |
| `docs/page.tsx` | Doc list page (server) — fetches docs+labels, renders `DocTable` |
| `comments/[id]/page.tsx` | Doc detail page (server) — fetches single doc with comments, renders `DocDetail` |

## API Routes (`src/app/api/`)

| File | Description |
|------|-------------|
| `auth/[...nextauth]/route.ts` | NextAuth catch-all handler (GET+POST) |
| `docs/route.ts` | `GET` list docs (with filters); `POST` refresh/full-refresh/load sync from Drive |
| `docs/add/route.ts` | `POST` add a doc by URL — validates via Drive, creates DB record, syncs comments |
| `docs/validate/route.ts` | `GET` validate a Google Drive URL — checks access, mime type, returns metadata |
| `docs/[id]/route.ts` | `GET` single doc; `PATCH` update role/status/labels |
| `docs/[id]/refresh/route.ts` | `POST` refresh single doc — updates Drive metadata then syncs comments |
| `docs/[id]/comments/route.ts` | `GET` fetch comment+suggestion text content from Drive for display |
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
| `doc-row.tsx` | Single doc row in the table — title, comment counts, labels, archive/edit/open buttons |
| `doc-detail.tsx` | Single doc detail view (client) — metadata panel, comment filters, comment table |
| `filter-bar.tsx` | Doc list filter bar — tri-state buttons for type/author/labels/active/comments + title regex |
| `comment-filter-bar.tsx` | Comment list filter bar — toggles for my threads/comments, show mode, suggestions |
| `comment-row.tsx` | Single comment row — expandable, shows content preview, thread panel, status actions |
| `comment-thread-panel.tsx` | Expanded thread view — shows all replies, reply textarea, resolve/reopen buttons |
| `add-doc-dialog.tsx` | Dialog to add a doc by URL — debounced validation, label picker |
| `edit-doc-dialog.tsx` | Dialog to edit doc role and labels |
| `refresh-button.tsx` | Refresh/Full Refresh/Load from Drive button — calls POST `/api/docs` then reloads list |
| `tri-state-button.tsx` | Tri-state filter buttons (off/include/exclude) with diagonal strikethrough + slow-click-to-reset |
| `label-badge.tsx` | Colored label pill with optional remove button |
| `label-picker.tsx` | Label selection grid for add/edit dialogs |
| `manage-labels-dialog.tsx` | Dialog to create/delete/reorder/recolor labels with pointer-based drag reorder |
| `color-picker.tsx` | Popover color grid for label color selection |
| `dialog-buttons.tsx` | Reusable Save/Cancel button pair for dialogs |
| `doc-type-icon.tsx` | SVG icons for Google Docs/Sheets/Slides by mime type |

### UI primitives (`src/components/ui/`)

Shadcn/ui components: `badge.tsx`, `button.tsx`, `checkbox.tsx`, `dialog.tsx`, `popover.tsx`, `select.tsx`, `sonner.tsx`

## Library (`src/lib/`)

| File | Description |
|------|-------------|
| `google-drive.ts` | Google Drive/Docs API client — OAuth2 with token refresh, comment fetching, suggestion parsing, thread detail, reply/resolve, file listing |
| `sync-comments.ts` | Comment sync engine — full-scan of Drive comments + Docs suggestions, creates/updates DB records, computes unarchive signals |
| `doc-filters.ts` | Client-side doc filtering (tri-state logic for active/comments/author/mimeType/labels/title regex) and sorting |
| `doc-queries.ts` | Shared Prisma include clause + transform for computing watched/open comment counts without loading full comment data |
| `prisma.ts` | Singleton PrismaClient with dev-mode write-op logging |
| `offline.ts` | Offline mode constants — `OFFLINE_MODE` flag, `OfflineModeError`, fallback user |
| `role-colors.ts` | Tailwind class maps for Author (blue) and Reviewer (violet) role badges/filters |
| `status.ts` | Read/write `Status` table — tracks `lastDriveUpdateTimestamp` per user for incremental sync |
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
| `suggestions.md` | Suggestion sync via Docs API, limitations |

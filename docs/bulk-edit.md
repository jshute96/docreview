# Bulk Edit Design

The Bulk Edit feature allows users to update roles, labels, and notes for multiple documents simultaneously. It is designed to be context-aware, skipping redundant operations and providing clear visual feedback about pending changes.

## UI/UX Design

### Entry Point
- An **"Edit All"** button is located in the `DocTable` header, next to the "Actions" column.
- It targets all documents currently visible in the table (respecting active filters and search terms).

### Bulk Edit Dialog

The dialog follows the shared dialog sizing pattern (see [`dialog-sizing.md`](./dialog-sizing.md)) —
the doc list is the flexible element that shrinks on viewport resize.

- **Dynamic Selection**: Displays a list of selected documents with their respective icons and titles. Users can remove documents from the bulk operation using the "X" button.
- **Tri-State Controls**: Role, State (Inbox/Archived), and Label buttons use a three-state logic:
    - `as-is`: No change to the document. Represented by a `?` overlay if the selection is inconsistent (mixed), or no overlay if all documents share the state.
    - `set` (+): Ensures the property is applied to all selected documents (e.g., sets Role to AUTHOR, or State to INBOX).
    - `clear` (-): Ensures the property is removed/negated (e.g., sets Role to REVIEWER, or State to ARCHIVED).
- **Context-Aware Cycling**: To minimize clicks, buttons automatically skip states that are redundant for the current selection. For example, if all selected documents are already ARCHIVED, clicking the "Inbox" button will skip the `clear` state and go directly from `as-is` to `set`.
- **Append Notes**: A text area for appending notes to all selected documents. It intelligently inserts a newline if the existing notes are non-empty and don't already end with one.

## Implementation Details

### Frontend (`src/components/bulk-edit-dialog.tsx`)
- **Consistency Checking**: A helper function `checkConsistency` determines if a property (like a label) is present on `all`, `none`, or `some` (mixed) of the selected documents.
- **Initialization**: Local state is initialized only when the dialog is opened (`onOpenChange`). This prevents accidental resets if the parent component re-renders.
- **Automatic State Reversion**: When a document is removed from the selection, the dialog re-evaluates all pending actions. If an action (e.g., "Add Label X") becomes redundant for the remaining selection, it reverts to `as-is`.

### Backend (`src/app/api/docs/bulk-update/route.ts`)
- **Batch Read**: All target docs are fetched in a single `findMany` call (not N+1 queries).
- **Transaction**: All writes are wrapped in `prisma.$transaction` for atomicity.
- **Validation**: Runtime checks on all inputs — `docIds` must be a non-empty string array (max 500), `role` and `labelUpdates` values must be valid `BulkEditState` strings, `appendNotes` must be a string if present.
- **No-Op Protection**: Before building an `update` call, the API checks whether any actual changes are required (role change, non-empty append notes, or label additions/removals). Unchanged docs are skipped but still included in the response from the initial batch read.
- **Response Shape**: Returns `{ docs, skipped }` — `docs` is the full list (updated + unchanged), `skipped` is the count of requested IDs not found in the database (e.g., docs owned by another user).

## Data Flow
1. User opens the dialog -> `initialDocs` and `allLabels` are captured.
2. User interacts with toggles -> `roleState` and `labelStates` (Record of `BulkEditState`) are updated.
3. User removes a doc -> `selectedDocs` is filtered; states are re-evaluated via `checkConsistency`.
4. User clicks "Save Changes" -> A `PATCH` request is sent with the target document IDs and the desired state updates.
5. API batch-reads all docs, builds updates, executes in a single transaction. Unchanged docs are returned from the initial read. Response includes a `skipped` count if any IDs were not found.
6. Frontend updates -> `onSave` callback propagates the updated document data back to the main table. A toast is shown if any docs were skipped.

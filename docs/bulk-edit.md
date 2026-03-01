# Bulk Edit Design

The Bulk Edit feature allows users to update roles, labels, and notes for multiple documents simultaneously. It is designed to be context-aware, skipping redundant operations and providing clear visual feedback about pending changes.

## UI/UX Design

### Entry Point
- An **"Edit All"** button is located in the `DocTable` header, next to the "Actions" column.
- It targets all documents currently visible in the table (respecting active filters and search terms).

### Bulk Edit Dialog
- **Dynamic Selection**: Displays a list of selected documents with their respective icons and titles. Users can remove documents from the bulk operation using the "X" button.
- **Tri-State Controls**: Role and Label buttons use a three-state logic:
    - `as-is`: No change to the document. Represented by a `?` overlay if the selection is inconsistent (mixed), or no overlay if all documents share the state.
    - `set` (+): Ensures the property is applied to all selected documents.
    - `clear` (-): Ensures the property is removed from all selected documents.
- **Context-Aware Cycling**: To minimize clicks, buttons automatically skip states that are redundant for the current selection. For example, if all selected documents already have a specific label, clicking that label will skip the `set` state and go directly from `as-is` to `clear`.
- **Append Notes**: A text area for appending notes to all selected documents. It intelligently inserts a newline if the existing notes are non-empty and don't already end with one.

## Implementation Details

### Frontend (`src/components/bulk-edit-dialog.tsx`)
- **Consistency Checking**: A helper function `checkConsistency` determines if a property (like a label) is present on `all`, `none`, or `some` (mixed) of the selected documents.
- **Initialization**: Local state is initialized only when the dialog is opened (`onOpenChange`). This prevents accidental resets if the parent component re-renders.
- **Automatic State Reversion**: When a document is removed from the selection, the dialog re-evaluates all pending actions. If an action (e.g., "Add Label X") becomes redundant for the remaining selection, it reverts to `as-is`.

### Backend (`src/app/api/docs/bulk-update/route.ts`)
- **Optimized Batching**: Performs updates document-by-document within a single bulk request.
- **No-Op Protection**: Before issuing a database `update` command, the API verifies if any actual changes are required (role change, non-empty append notes, or label additions/removals). If no change is detected, it returns the existing document data immediately, avoiding unnecessary database transactions.

## Data Flow
1. User opens the dialog -> `initialDocs` and `allLabels` are captured.
2. User interacts with toggles -> `roleState` and `labelStates` (Record of `BulkEditState`) are updated.
3. User removes a doc -> `selectedDocs` is filtered; states are re-evaluated via `checkConsistency`.
4. User clicks "Save Changes" -> A `PATCH` request is sent with the target document IDs and the desired state updates.
5. API processes each doc -> Skips update if state matches; otherwise, performs optimized `prisma.doc.update`.
6. Frontend updates -> `onSave` callback propagates the updated document data back to the main table.

## Labels

Labels are colored tags for organizing your documents. You might use them for projects, review stages, teams, or any other grouping that makes sense for your workflow.

### Managing labels

Open **Manage Labels** from the menu to create, edit, and organize your labels:

- **Create** -- Enter a name and pick a color from the palette.
- **Reorder** -- Drag labels up and down to set their display order. This order is used everywhere labels appear: the filter bar, label pickers, and document rows.
- **Change color** -- Click the color swatch to pick a new color.
- **Delete** -- Remove a label. The dialog shows how many documents use each label so you can see the impact before deleting.

Changes are saved when you click Save.

### Applying labels to documents

There are several ways to add or remove labels:

- **Edit dialog** -- Click the edit button on any document row to open its edit dialog, which includes a label picker grid.
- **Comment detail page** -- The edit option in the menu opens the same dialog.
- **Bulk edit** -- Select multiple documents and use the label controls to add or remove labels across all of them at once.
- **Load dialog** -- When importing documents, you can pre-assign labels before adding.

### Filtering by label

Each label appears as a tri-state filter toggle in the filter bar. You can include or exclude documents with specific labels. Multiple label filters combine with AND logic.

## Notes

Notes are free-text annotations you attach to documents. They appear below the document title in the list (truncated, with full text on hover) and in the comment detail page header.

### Editing notes

- **Edit dialog** -- The notes textarea auto-resizes as you type. Notes are saved when you click Save.
- **Bulk edit** -- The notes field in bulk edit *appends* to existing notes rather than replacing them, so you can add a note to many documents without overwriting what's already there.
- **Load dialog** -- Notes entered during import are set on new documents and appended to existing ones.

Notes from Gmail imports include information about who shared the document and when, and can also include snippets from comment notification emails. Notes from multiple emails for the same document are combined.

## Edit dialog

The edit dialog (pencil icon on each document row) lets you change several properties at once:

- **Role** -- Toggle between Author and Reviewer.
- **Status** -- Toggle between Inbox and Archived.
- **Star** -- Toggle on or off.
- **Labels** -- Grid picker showing all your labels with checkboxes.
- **Notes** -- Auto-resizing textarea.

## Bulk edit

To edit multiple documents at once, click **Edit All** in the table header, or use multi-select:

- **Click** a row to select it.
- **Ctrl+click** (Cmd+click on Mac) to toggle individual rows.
- **Shift+click** to select a range.

The bulk edit dialog shows tri-state controls for role, status, star, and each label:

- **Off** (dash) -- Leave as-is for all selected documents.
- **Include** (check) -- Set this value on all selected documents.
- **Exclude** (cross) -- Remove or unset this value on all selected documents.

The controls are context-aware: if all selected documents already share the same value, the control skips redundant states when cycling.

The **notes** field in bulk edit appends to existing notes. You can also remove documents from the selection with the X button or the Delete/Backspace key.

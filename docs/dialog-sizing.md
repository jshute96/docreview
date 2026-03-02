# Dialog Sizing

Dialogs that contain a variable-length list of items (doc list, selection list, etc.)
follow a shared sizing pattern. This keeps behavior consistent and avoids common
pitfalls like the dialog jumping when items are added or removed.

## Layout structure

```
┌──────────────────────────────┐
│  Fixed header / options      │  shrink-0
│  ─────────────────────────── │
│  ┌──────────────────────┐    │
│  │  Item list           │    │  shrink (flexible)
│  │  (scrollable)        │    │
│  └──────────────────────┘    │
│  Fixed footer / controls     │  shrink-0
└──────────────────────────────┘
```

The dialog is a flex column. Only the item list is flexible (`shrink`); everything
else is `shrink-0` and always fully visible.

## Item list height

The list uses three CSS properties:

| Property    | Value                            | Purpose                          |
|-------------|----------------------------------|----------------------------------|
| `height`    | `calc(N * 1.5rem + 2px)`        | Preferred size (N = `docListRows` or equivalent state) |
| `minHeight` | `calc(5 * 1.5rem + 2px)`        | Floor — viewport shrink stops here |
| `maxHeight` | `calc(15 * 1.5rem + 2px)`       | Cap — scroll kicks in above this  |

Each row is `h-6` (1.5rem). The `+ 2px` accounts for the container border.

## Sizing rules

1. **Small lists (≤ 5 items)** — the list height matches the item count exactly.
   The dialog has a fixed height with no empty space below the last row.

2. **Removing an item (X click)** — the list height does NOT change. The row
   disappears but the container keeps its size. This prevents the dialog from
   jumping when repeatedly clicking X.

3. **Changing views or filters** — the list height recomputes based on the new
   item count (post-removals). The user expects the list to resize when they
   explicitly switch context.

4. **Refreshing / rescanning** — the list height recomputes based on fresh data,
   since removals are reset and counts may have changed.

5. **Viewport shrink** — the `shrink` CSS class lets the browser compress the list
   down to `minHeight` (5 rows) before the overall dialog scrollbar appears.
   All other sections stay at their natural size.

## Implementation pattern

Track the preferred row count in a state variable (e.g. `docListRows`). Update it
on scan/refresh and on view/filter changes, but NOT on individual item removal.
The variable is capped to `Math.min(15, Math.max(5, itemCount))`.

```tsx
const [docListRows, setDocListRows] = useState(5);

// On scan/refresh:
setDocListRows(Math.min(15, Math.max(5, items.length)));

// On view switch:
setDocListRows(Math.min(15, Math.max(5, filteredItems.length)));

// Style:
style={{
  height: `calc(${docListRows} * 1.5rem + 2px)`,
  minHeight: `calc(5 * 1.5rem + 2px)`,
  maxHeight: `calc(15 * 1.5rem + 2px)`,
}}
```

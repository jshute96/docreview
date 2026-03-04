# Cross-Tab Notification System

When a user has multiple Docreview tabs open (e.g. doc list + several comment pages), changes made in one tab need to propagate to the others. This is handled by the [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel_API), which delivers messages to all same-origin tabs.

## Architecture

```
Tab A (sender)                          Tab B (receiver)
─────────────────                       ─────────────────
User action
  → API call (apiFetch)
  → Update local state
  → broadcastChange(event, contextId)
      │                                 useCrossTabListener(handler)
      │  BroadcastChannel "docreview-sync"    │
      └──────────────────────────────────────→ handler(event)
                                                → apiFetch(..., { reason })
                                                → Update local state
```

### Singleton channel (self-delivery prevention)

Both `broadcastChange()` and `useCrossTabListener()` share a **single `BroadcastChannel` instance per tab**, created lazily by `getChannel()`. This is critical for correctness.

The BroadcastChannel spec says `postMessage()` delivers to every `BroadcastChannel` object on the same channel name **except the object that called `postMessage()`**. By using one shared instance, the sending tab's own listener never fires — only other tabs receive the message.

If sending and listening used separate `BroadcastChannel` objects (e.g. creating a new one per `broadcastChange()` call), the listener's object is different from the sender's, so the spec considers it a valid recipient and delivers the message. This caused same-tab self-delivery: after replying to a comment, the same tab would receive its own broadcast, trigger a full refetch, and undo the frozen sort order (causing the comment to jump in the table).

```
WRONG — separate instances, same tab receives its own broadcast:
  broadcastChange():  new BroadcastChannel("docreview-sync").postMessage(...)  ──┐
  useCrossTabListener(): ch = new BroadcastChannel("docreview-sync")             │
                          ch.onmessage ← fires! (different object)  ←────────────┘

RIGHT — shared singleton, same tab is excluded by spec:
  broadcastChange():     sharedCh.postMessage(...)  ──── not delivered to sharedCh
  useCrossTabListener(): sharedCh.addEventListener(...)  ← only fires from OTHER tabs
```

The singleton is a module-level variable (`let sharedChannel`), so it lives for the lifetime of the page. Each tab gets its own module scope, so each tab has its own singleton — there is one `BroadcastChannel` object per tab, not one shared across tabs.

Key files:
- `src/lib/cross-tab.ts` — `broadcastChange()`, `useCrossTabListener()`, `crossTabReason()`, event types
- `src/lib/api-fetch.ts` — `apiFetch()` wrapper that sends context ID + reason headers
- `src/lib/request-context.ts` — server-side logging of `[CrossTab]` reason lines

## Event Types

Three event types, defined as `CrossTabEvent`:

| Type | Payload | Meaning |
|------|---------|---------|
| `docs` | `docId?` | A document was added, updated, archived, or deleted. Optional `docId` identifies the specific doc. |
| `labels` | _(none)_ | Labels were created, deleted, reordered, or recolored. |
| `comments` | `docId` (required) | Comments on a specific document changed (synced, replied, resolved, archived). |

The `docId` field on `docs` events is optional because some operations affect multiple documents (bulk edit, load from Drive, full refresh) and don't target a single doc.

## Wire Format

Messages sent over BroadcastChannel are `CrossTabMessage` objects:

```typescript
type CrossTabMessage = CrossTabEvent & { fromContextId?: string };
```

The `fromContextId` is the 8-char hex context ID from the sender's API call, included so receivers can trace the chain in server logs.

## Senders

Every component that mutates data broadcasts after a successful API call. The pattern is:

```typescript
const contextId = generateContextId();
const res = await apiFetch(`/api/...`, { contextId });
// ... update local state ...
broadcastChange({ type: "docs", docId: doc.docId }, contextId);
```

### Broadcast Call Sites

**`docs` events:**
| Source | docId? | Trigger |
|--------|--------|---------|
| `refresh-button.tsx` | no | Refresh / Full Refresh / Refresh from Gmail |
| `load-dialog.tsx` | no | Add docs from Drive scan |
| `bulk-edit-dialog.tsx` | no | Bulk edit labels/role/status/notes |
| `doc-row.tsx` | yes | Archive / unarchive from doc list |
| `doc-detail.tsx` | yes | Archive / unarchive from detail page |
| `add-doc-dialog.tsx` | yes | Add doc via dialog in doc list |
| `add-doc-page-client.tsx` | yes | Add doc via standalone page |

**`labels` events:**
| Source | Trigger |
|--------|---------|
| `manage-labels-dialog.tsx` | Create, delete, recolor, or reorder labels |

**`comments` events:**
| Source | Trigger |
|--------|---------|
| `doc-detail.tsx` handleRefresh | Per-doc comment sync |
| `doc-detail.tsx` handleArchiveAll | Bulk archive visible comments |
| `comment-row.tsx` postReply | Reply, resolve, or reopen a thread |
| `comment-row.tsx` updateStatus | Change comment status (inbox/archive/mute) |

## Receivers

Three components listen via `useCrossTabListener`:

### doc-table.tsx (doc list page)
- **Handler:** `refetchAll`
- **Responds to:** all event types
- **Action:** Full parallel refetch of `/api/docs?includeArchived=true` and `/api/labels`. Unconditional because the doc list shows aggregate comment counts, so even a comment change on a single doc affects the displayed data.

### doc-detail.tsx (comment detail page)
- **Handler:** `handleCrossTab`
- **Responds to:** selectively by event type
- **`docs` event:** If `docId` is present and doesn't match this page's doc, the event is **ignored**. Otherwise, refetches the doc and labels in parallel.
- **`labels` event:** Always refetches the doc and labels in parallel.
- **`comments` event:** Only acts if `docId` matches this page's doc. Refetches the doc, threads, and content. Events for other docs are **ignored**.

### add-doc-page-client.tsx (add document page)
- **Handler:** `refetchLabels`
- **Responds to:** all event types
- **Action:** Refetches `/api/labels` only. The add-doc page only needs fresh labels for the label picker.

## Debouncing

`useCrossTabListener` debounces incoming messages (default 300ms). If multiple broadcasts arrive in quick succession (e.g. bulk operations), only the last event fires the handler. This means only the final event's payload is used — earlier events are dropped.

## Server-Side Logging

When a receiver makes API calls in response to a cross-tab event, it includes a `reason` string in the first request's headers. The server logs this as a `[CrossTab]` line before the `[API]` line:

```
2026-03-03 14:22:01 a1b2c3d4 INFO  [CrossTab] doc-list got notification from 9f3e2a1b: docs docId=abc123
2026-03-03 14:22:01 a1b2c3d4 INFO  [API] GET /api/docs
```

The `crossTabReason()` helper builds the reason string:
- `receiver` — which component is handling the event (`doc-list`, `doc-detail`, `add-doc`)
- `fromContextId` — the sender's context ID (if present)
- `payload` — event type and docId if applicable

Only the first API call in a handler carries the reason, to avoid duplicate log lines when multiple requests share a context ID.

## Context ID Flow

```
Sender tab                              Receiver tab                          Server log
──────────                              ────────────                          ──────────
generateContextId() → "9f3e2a1b"
apiFetch(/api/docs, {contextId})  ───→                                       9f3e2a1b [API] PATCH /api/docs/abc
broadcastChange({docs, docId}, "9f3e2a1b")
         │
         └──→ handler receives {docs, docId, fromContextId: "9f3e2a1b"}
              generateContextId() → "c4d5e6f7"
              reason = "doc-list got notification from 9f3e2a1b: docs docId=abc"
              apiFetch(/api/docs, {contextId: "c4d5e6f7", reason}) ───→      c4d5e6f7 [CrossTab] doc-list got notification from 9f3e2a1b: docs docId=abc
                                                                             c4d5e6f7 [API] GET /api/docs
              apiFetch(/api/labels, {contextId: "c4d5e6f7"})       ───→      c4d5e6f7 [API] GET /api/labels
```

This lets you trace a chain: find the sender's context ID in the `[CrossTab]` line, then search for that ID to find the original mutation.

## Ignored Events

`doc-detail` silently ignores cross-tab events that don't apply to the current document — `docs` events with a different `docId`, and `comments` events for other docs. `doc-table` and `add-doc-page-client` respond to everything.

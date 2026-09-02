// Conversion utilities for suggestion data scraped from the Google Docs DOM
// by the Chrome extension's getSuggestions() function.
//
// Extension suggestions are display-only (not persisted). They are converted
// into synthetic Comment objects and CommentThread entries for rendering on the
// comments page alongside DB-sourced suggestions.

import type { CommentThread, SuggestionContent } from "@/lib/google-drive";
import type { ExtensionSuggestion } from "@/lib/bridge-to-extension";
import { ExtSuggestionStatus, parseExtSuggestionStatus } from "@/lib/extension-wire";
import { SuggestionLabel } from "@/lib/suggestion-labels";
import { hasYear } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

/**
 * Parse a relative timestamp from the Google Docs DOM into a Date.
 * Handles formats produced by Google Docs:
 *   - "6:29 PM Feb 21"    — time + month day (current year, rolls back if future)
 *   - "5:06 AM Yesterday" — time + relative day
 *   - "3:15 PM Today"     — time + relative day
 * The wall-clock time is interpreted in the runtime's local timezone (the
 * browser on the thread-panel path, the server on the merge path), which is
 * only exactly right when that matches the timezone the Docs UI rendered in.
 * Returns null if unparseable.
 */
export function parseExtensionTimestamp(ts: string): Date | null {
  if (!ts) return null;

  // "HH:MM AM/PM Yesterday" or "HH:MM AM/PM Today"
  const relMatch = ts.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s+(Yesterday|Today)$/i);
  if (relMatch) {
    const d = new Date();
    if (/yesterday/i.test(relMatch[2])) d.setDate(d.getDate() - 1);
    const parsed = new Date(`${d.toDateString()} ${relMatch[1]}`);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  // "HH:MM AM/PM Mon DD" e.g. "6:29 PM Feb 21"
  const absMatch = ts.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s+(\w{3})\s+(\d{1,2})$/);
  if (absMatch) {
    const now = new Date();
    const parsed = new Date(`${absMatch[2]} ${absMatch[3]}, ${now.getFullYear()} ${absMatch[1]}`);
    if (isNaN(parsed.getTime())) return null;
    // If the date is in the future, it was probably last year
    if (parsed > now) parsed.setFullYear(parsed.getFullYear() - 1);
    return parsed;
  }

  // Fallback: let Date parse it, but only if it carries its own year. A
  // year-less string V8 doesn't recognize (e.g. "Feb 21", or a Docs locale
  // format the regexes above miss) parses to year 2001 — silently wrong, and
  // worse than returning null, which shows the scraped text verbatim instead.
  if (!hasYear(ts)) return null;
  const fallback = new Date(ts);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Scraped timestamp -> ISO string, so the UI formats it the same way as
 * Drive-sourced comment timestamps. Falls back to the raw scraped text if it
 * can't be parsed (FriendlyDate then displays it verbatim).
 */
function toIsoTimestamp(ts: string): string {
  const d = parseExtensionTimestamp(ts);
  return d ? d.toISOString() : ts;
}

// ---------------------------------------------------------------------------
// Conversion to display objects
// ---------------------------------------------------------------------------

/** Convert an extension suggestion to a CommentThread for the thread panel. */
export function extensionToThread(s: ExtensionSuggestion): CommentThread {
  const content =
    s.suggestionType === SuggestionLabel.Replace ? `Replace "${s.oldText}" with "${s.newText}"` :
    s.suggestionType === SuggestionLabel.Add ? `Add "${s.newText}"` :
    s.suggestionType === SuggestionLabel.Delete ? `Delete "${s.oldText}"` :
    s.description || s.suggestionType;
  return {
    id: s.id,
    author: s.author,
    fromMe: s.isMine,
    content,
    createdTime: toIsoTimestamp(s.timestamp),
    resolved: parseExtSuggestionStatus(s.status) !== ExtSuggestionStatus.Open,
    replies: s.replies.map(r => ({
      id: "", // scraped from the Docs UI, so no Drive reply ID — not editable
      author: r.author,
      fromMe: r.isMine,
      content: r.text,
      htmlContent: r.html,
      createdTime: toIsoTimestamp(r.timestamp),
      action: r.action,
    })),
    ...(s.originalContentDeleted ? { originalContentDeleted: true } : {}),
    ...(s.tabName ? { tabName: s.tabName } : {}),
  };
}

/** Extract SuggestionContent (old/new text) from an extension suggestion. */
export function extensionToSuggestionContent(s: ExtensionSuggestion): SuggestionContent {
  return {
    insertedText: s.newText,
    deletedText: s.oldText,
    ...(s.description ? { description: s.description } : {}),
  };
}

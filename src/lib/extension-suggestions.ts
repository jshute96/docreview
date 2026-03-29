// Conversion utilities for suggestion data scraped from the Google Docs DOM
// by the Chrome extension's getSuggestions() function.
//
// Extension suggestions are display-only (not persisted). They are converted
// into synthetic Comment objects and CommentThread entries for rendering on the
// comments page alongside DB-sourced suggestions.

import type { Comment } from "@prisma/client";
import type { CommentThread, SuggestionContent } from "@/lib/google-drive";
import type { ExtensionSuggestion } from "@/lib/bridge-to-extension";

/**
 * Prefix for synthetic commentId values on extension-sourced suggestions.
 * These comments exist only in memory for display — they have no DB record,
 * so API calls (archive, star, mark read, etc.) should skip them.
 */
export const EXTENSION_COMMENT_PREFIX = "ext-";

/** Check whether a Comment is a synthetic extension-sourced entry. */
export function isExtensionComment(c: Comment): boolean {
  return c.commentId.startsWith(EXTENSION_COMMENT_PREFIX);
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

/**
 * Parse a relative timestamp from the Google Docs DOM into a Date.
 * Handles formats produced by Google Docs:
 *   - "6:29 PM Feb 21"    — time + month day (current year, rolls back if future)
 *   - "5:06 AM Yesterday" — time + relative day
 *   - "3:15 PM Today"     — time + relative day
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

  // Fallback: let Date parse it
  const fallback = new Date(ts);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

/** Map extension suggestion types ("Replace"/"Add"/"Delete") to Prisma enum values. */
function extensionSuggestionType(s: ExtensionSuggestion): "INSERT" | "DELETE" | "EDIT" {
  if (s.suggestionType === "Add") return "INSERT";
  if (s.suggestionType === "Delete") return "DELETE";
  return "EDIT";
}

// ---------------------------------------------------------------------------
// Conversion to display objects
// ---------------------------------------------------------------------------

/**
 * Create a synthetic Comment object from an extension suggestion.
 * These aren't persisted — they exist only for display on the comments page.
 * The commentId is prefixed with "ext-" so callers can identify them.
 */
export function extensionToComment(s: ExtensionSuggestion, docId: string): Comment {
  return {
    commentId: `${EXTENSION_COMMENT_PREFIX}${s.id}`,
    docId,
    googleCommentId: s.id,
    googleSuggestionId: null,
    suggestionContentHash: null,
    type: "SUGGESTION",
    suggestionType: extensionSuggestionType(s),
    resolved: s.status !== "open",
    isThreadAuthor: s.isMine,
    isReplyAuthor: s.replies.some(r => r.isMine),
    isRead: true,
    isStarred: false,
    assignedToMe: false,
    mentionedMe: false,
    mentionedMeUnreplied: false,
    status: "INBOX",
    driveCreatedAt: parseExtensionTimestamp(s.timestamp),
    driveModifiedAt: s.replies.length > 0
      ? parseExtensionTimestamp(s.replies[s.replies.length - 1].timestamp)
      : parseExtensionTimestamp(s.timestamp),
    replyCount: s.replies.length,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Convert an extension suggestion to a CommentThread for the thread panel. */
export function extensionToThread(s: ExtensionSuggestion): CommentThread {
  const content =
    s.suggestionType === "Replace" ? `Replace "${s.oldText}" with "${s.newText}"` :
    s.suggestionType === "Add" ? `Add "${s.newText}"` :
    s.suggestionType === "Delete" ? `Delete "${s.oldText}"` :
    s.suggestionType;
  return {
    id: s.id,
    author: s.author,
    fromMe: s.isMine,
    content,
    createdTime: s.timestamp,
    resolved: s.status !== "open",
    replies: s.replies.map(r => ({
      author: r.author,
      fromMe: r.isMine,
      content: r.text,
      htmlContent: r.html,
      createdTime: r.timestamp,
      action: r.action,
    })),
  };
}

/** Extract SuggestionContent (old/new text) from an extension suggestion. */
export function extensionToSuggestionContent(s: ExtensionSuggestion): SuggestionContent {
  return {
    insertedText: s.newText,
    deletedText: s.oldText,
  };
}

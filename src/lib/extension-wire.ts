/**
 * Vocabulary the Chrome extension uses in the messages it sends us.
 *
 * It uses two different spellings for the same idea: the sync request body
 * carries the lowercase `ExtCommentType`, while the `commentSynced` tab message
 * is uppercased to the Prisma spelling before it is sent
 * (`background-comments.js`). Each boundary parses the one it is given.
 */
import { CommentType } from "@prisma/client";

/** How the extension names the two kinds of thread. */
export const ExtCommentType = {
  Comment: "comment",
  Suggestion: "suggestion",
} as const;

export type ExtCommentType = (typeof ExtCommentType)[keyof typeof ExtCommentType];

/** Narrows an untrusted value from the extension; anything else is undefined. */
export function parseExtCommentType(value: unknown): ExtCommentType | undefined {
  return value === ExtCommentType.Comment || value === ExtCommentType.Suggestion ? value : undefined;
}

/**
 * Narrows the value carried by `commentSynced`, which the extension uppercases
 * to the Prisma spelling before sending. Its lowercase form is accepted too:
 * whatever this page ships, an already-installed extension keeps sending what
 * its own version sends.
 */
export function parseCommentType(value: unknown): CommentType | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return upper === CommentType.COMMENT || upper === CommentType.SUGGESTION
    ? (upper as CommentType)
    : undefined;
}

/** Narrows an untrusted suggestion status; unknown values are treated as open,
 *  since only a known accepted/rejected should mark a suggestion resolved. */
export function parseExtSuggestionStatus(value: unknown): ExtSuggestionStatus {
  return value === ExtSuggestionStatus.Accepted || value === ExtSuggestionStatus.Rejected
    ? value
    : ExtSuggestionStatus.Open;
}

/** State of a suggestion as the extension scrapes it from the open document. */
export const ExtSuggestionStatus = {
  Open: "open",
  Accepted: "accepted",
  Rejected: "rejected",
} as const;

export type ExtSuggestionStatus = (typeof ExtSuggestionStatus)[keyof typeof ExtSuggestionStatus];

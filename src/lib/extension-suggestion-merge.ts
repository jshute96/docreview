// Merges suggestion data from the Chrome extension (DOM scraping) into the database.
//
// Similar to mergeSuggestionsFromGmail but with extension-specific data:
// - Disco IDs (AAAB format, same as Gmail's discussionId)
// - Suggestion type, old/new text (for content hash)
// - Accept/reject status (maps to resolved: true)
// - Author name and isMine flag
// - Reply count
// - Relative timestamps from the DOM
//
// Merge strategy:
//   1. Check if disco ID already exists in the doc → update metadata
//   2. Compute content hash, look up rows without a googleCommentId
//   3. Exactly one match → merge disco ID, author, reply count, status
//   4. No match or multiple matches → insert new row (extension-first)

import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { computeSuggestionHash, gmailActionToSuggestionType } from "@/lib/suggestion-hash";
import { computeMentionedMeUnreplied } from "@/lib/google-drive";
import { bumpLastCommentActivity } from "@/lib/sync-comments";
import { parseExtensionTimestamp } from "@/lib/extension-suggestions";
import type { Comment } from "@prisma/client";

/** Shape of a single extension suggestion as received from the API request body. */
export interface ExtensionSuggestionInput {
  id: string;              // disco ID
  suggestionType: string;  // "Replace", "Add", "Delete"
  status: string;          // "open", "accepted", "rejected"
  oldText: string;
  newText: string;
  author: string;
  isMine: boolean;
  timestamp: string;
  replies: {
    author: string;
    isMine: boolean;
    timestamp: string;
    text: string;
    html?: string;
    action?: string;
  }[];
}

export interface ExtensionMergeResult {
  merged: number;
  inserted: number;
  updated: number;
  resolved: number;
  comments: Comment[];
}

/**
 * Check whether a reply mentions the user's email address.
 * Google Docs @mentions render as `mailto:` links in the HTML.
 */
function replyMentionsEmail(reply: ExtensionSuggestionInput["replies"][number], emailLower: string): boolean {
  const html = reply.html ?? reply.text;
  return html.toLowerCase().includes(emailLower);
}

/**
 * Compute mentionedMe and mentionedMeUnreplied from extension reply data.
 * Delegates unreplied-mention logic to shared computeMentionedMeUnreplied().
 */
function computeMentionFlags(
  replies: ExtensionSuggestionInput["replies"],
  emailLower: string,
): { mentionedMe: boolean; mentionedMeUnreplied: boolean } {
  const replyMentionFlags = replies.map((r) => !r.action && replyMentionsEmail(r, emailLower));
  const replyAuthorMeFlags = replies.map((r) => r.isMine);
  const mentionedMe = replyMentionFlags.some(Boolean);
  // Suggestions have no top-level @mention (the body is a text change, not a comment)
  const mentionedMeUnreplied = computeMentionedMeUnreplied(false, replyMentionFlags, replyAuthorMeFlags);
  return { mentionedMe, mentionedMeUnreplied };
}

/**
 * Merge extension-scraped suggestions into the database for a document.
 * Returns the final state of all suggestion Comment records for the doc.
 */
export async function mergeExtensionSuggestions(
  docId: string,
  googleDocId: string,
  suggestions: ExtensionSuggestionInput[],
  userEmail: string,
): Promise<ExtensionMergeResult> {
  const t0 = Date.now();
  let merged = 0;
  let inserted = 0;
  let updated = 0;
  let resolved = 0;

  const emailLower = userEmail.toLowerCase();

  logInfo(`[Suggestions:Ext] ${googleDocId}: merging ${suggestions.length} suggestions from extension`);

  for (const s of suggestions) {
    const actionType = gmailActionToSuggestionType(s.suggestionType);
    const deletedText = s.suggestionType === "Delete" || s.suggestionType === "Replace" ? s.oldText : "";
    const insertedText = s.suggestionType === "Add" || s.suggestionType === "Replace" ? s.newText : "";
    const contentHash = computeSuggestionHash(actionType, deletedText, insertedText);
    const createdAt = parseExtensionTimestamp(s.timestamp);
    const lastReplyTs = s.replies.length > 0
      ? parseExtensionTimestamp(s.replies[s.replies.length - 1].timestamp)
      : null;
    const mention = computeMentionFlags(s.replies, emailLower);

    // Common fields for all DB writes
    const commentData = {
      replyCount: s.replies.length,
      resolved: s.status === "accepted" || s.status === "rejected",
      isThreadAuthor: s.isMine,
      isReplyAuthor: s.replies.some(r => r.isMine),
      mentionedMe: mention.mentionedMe,
      mentionedMeUnreplied: mention.mentionedMeUnreplied,
      driveCreatedAt: createdAt,
      driveModifiedAt: lastReplyTs ?? createdAt,
    };

    logInfo(`[Suggestions:Ext] ${googleDocId}: processing ${s.id} ${actionType} "${s.oldText.substring(0, 20)}"→"${s.newText.substring(0, 20)}" status=${s.status} hash=${contentHash.substring(0, 12)}…`);

    // 1. Check if this disco ID already exists — update metadata
    const existingById = await prisma.comment.findFirst({
      where: { docId, googleCommentId: s.id },
    });
    if (existingById) {
      logInfo(`[Suggestions:Ext] ${googleDocId}: ${s.id} already exists as ${existingById.commentId} — updating metadata`);
      if (commentData.resolved && !existingById.resolved) resolved++;
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { commentId: existingById.commentId },
          data: commentData,
        });
        await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
      });
      updated++;
    } else {
      // 2. Look up by content hash (rows without a googleCommentId — not yet merged from Gmail/extension)
      const candidates = await prisma.comment.findMany({
        where: {
          docId,
          type: "SUGGESTION",
          suggestionContentHash: contentHash,
          googleCommentId: null,
        },
      });

      if (candidates.length === 1) {
        // 3. Unique match — merge extension data into existing Drive-created row.
        // We only merge when there's exactly one candidate to avoid pairing the
        // wrong disco ID with the wrong googleSuggestionId.
        const existing = candidates[0];
        logInfo(`[Suggestions:Ext] ${googleDocId}: merged ${s.id} into ${existing.commentId} by hash`);
        if (commentData.resolved && !existing.resolved) resolved++;
        await prisma.$transaction(async (tx) => {
          await tx.comment.update({
            where: { commentId: existing.commentId },
            data: {
              googleCommentId: s.id,
              ...commentData,
            },
          });
          await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
        });
        merged++;
      } else {
        // 4. No match, or multiple matches — insert new row (extension-first).
        // Multiple matches are ambiguous — we can't confidently pair a disco ID
        // with a specific googleSuggestionId, so we insert a separate row.
        if (candidates.length > 1) {
          logWarning(`[Suggestions:Ext] ${googleDocId}: ${candidates.length} hash matches for ${s.id} — inserting separate row`);
        } else {
          logInfo(`[Suggestions:Ext] ${googleDocId}: inserted ${s.id} ${actionType} (extension-first)`);
        }
        await prisma.$transaction(async (tx) => {
          await tx.comment.create({
            data: {
              docId,
              googleCommentId: s.id,
              type: "SUGGESTION",
              suggestionType: actionType,
              suggestionContentHash: contentHash,
              status: "INBOX",
              ...commentData,
            },
          });
          await bumpLastCommentActivity(docId, [commentData.driveCreatedAt, commentData.driveModifiedAt], tx);
        });
        inserted++;
      }
    }
  }

  // Fetch final state of all suggestion records for this doc
  const comments = await prisma.comment.findMany({
    where: { docId, type: "SUGGESTION" },
    orderBy: { driveCreatedAt: "desc" },
  });

  logInfo(`[Suggestions:Ext] ${googleDocId}: done — ${merged} merged, ${inserted} inserted, ${updated} updated, ${resolved} resolved (${Date.now() - t0}ms)`);

  return { merged, inserted, updated, resolved, comments };
}

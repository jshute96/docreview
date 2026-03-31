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
//   1. Check if disco ID already exists in the doc → skip (already merged)
//   2. Compute content hash, look up rows without a googleCommentId
//   3. Exactly one match → merge disco ID, author, reply count, status
//   4. No match → insert new row (extension-first)
//   5. Multiple matches → skip (ambiguous)

import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { computeSuggestionHash, gmailActionToSuggestionType } from "@/lib/suggestion-hash";
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
    action?: string;
  }[];
}

export interface ExtensionMergeResult {
  merged: number;
  inserted: number;
  skipped: number;
  resolved: number;
  comments: Comment[];
}

/**
 * Merge extension-scraped suggestions into the database for a document.
 * Returns the final state of all suggestion Comment records for the doc.
 */
export async function mergeExtensionSuggestions(
  docId: string,
  googleDocId: string,
  suggestions: ExtensionSuggestionInput[],
): Promise<ExtensionMergeResult> {
  const t0 = Date.now();
  let merged = 0;
  let inserted = 0;
  let skipped = 0;
  let resolved = 0;

  logInfo(`[Suggestions:Ext] ${googleDocId}: merging ${suggestions.length} suggestions from extension`);

  for (const s of suggestions) {
    const actionType = gmailActionToSuggestionType(s.suggestionType);
    const deletedText = s.suggestionType === "Delete" || s.suggestionType === "Replace" ? s.oldText : "";
    const insertedText = s.suggestionType === "Add" || s.suggestionType === "Replace" ? s.newText : "";
    const contentHash = computeSuggestionHash(actionType, deletedText, insertedText);
    const isResolved = s.status === "accepted" || s.status === "rejected";
    const createdAt = parseExtensionTimestamp(s.timestamp);
    const lastReplyTs = s.replies.length > 0
      ? parseExtensionTimestamp(s.replies[s.replies.length - 1].timestamp)
      : null;

    logInfo(`[Suggestions:Ext] ${googleDocId}: processing ${s.id} ${actionType} "${s.oldText.substring(0, 20)}"→"${s.newText.substring(0, 20)}" status=${s.status} hash=${contentHash.substring(0, 12)}…`);

    // 1. Check if this disco ID already exists (idempotency)
    const existingById = await prisma.comment.findFirst({
      where: { docId, googleCommentId: s.id },
    });
    if (existingById) {
      logInfo(`[Suggestions:Ext] ${googleDocId}: ${s.id} already exists as ${existingById.commentId} — updating metadata`);
      // Update fields that may have changed: reply count, resolved status, author info
      const updates: Record<string, unknown> = {};
      if (s.replies.length > existingById.replyCount) {
        updates.replyCount = s.replies.length;
      }
      if (isResolved && !existingById.resolved) {
        updates.resolved = true;
        resolved++;
      }
      if (s.isMine && !existingById.isThreadAuthor) {
        updates.isThreadAuthor = true;
      }
      if (s.replies.some(r => r.isMine) && !existingById.isReplyAuthor) {
        updates.isReplyAuthor = true;
      }
      if (lastReplyTs && (!existingById.driveModifiedAt || lastReplyTs > existingById.driveModifiedAt)) {
        updates.driveModifiedAt = lastReplyTs;
      }
      if (Object.keys(updates).length > 0) {
        await prisma.comment.update({
          where: { commentId: existingById.commentId },
          data: updates,
        });
        logInfo(`[Suggestions:Ext] ${googleDocId}: updated ${existingById.commentId}: ${Object.keys(updates).join(", ")}`);
      }
      skipped++;
      continue;
    }

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

      const promoteStatus = existing.status === "ARCHIVED" ? "INBOX" : undefined;
      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { commentId: existing.commentId },
          data: {
            googleCommentId: s.id,
            replyCount: Math.max(s.replies.length, existing.replyCount),
            isThreadAuthor: s.isMine || existing.isThreadAuthor,
            isReplyAuthor: s.replies.some(r => r.isMine) || existing.isReplyAuthor,
            ...(isResolved && !existing.resolved ? { resolved: true } : {}),
            ...(createdAt ? { driveCreatedAt: createdAt } : {}),
            ...(lastReplyTs ? { driveModifiedAt: lastReplyTs } : {}),
            ...(promoteStatus ? { status: promoteStatus } : {}),
          },
        });
        await bumpLastCommentActivity(docId, [createdAt, lastReplyTs], tx);
      });
      if (isResolved && !existing.resolved) resolved++;
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
            resolved: isResolved,
            isThreadAuthor: s.isMine,
            isReplyAuthor: s.replies.some(r => r.isMine),
            status: "INBOX",
            driveCreatedAt: createdAt,
            driveModifiedAt: lastReplyTs,
            replyCount: s.replies.length,
          },
        });
        await bumpLastCommentActivity(docId, [createdAt, lastReplyTs], tx);
      });
      inserted++;
    }
  }

  // Fetch final state of all suggestion records for this doc
  const comments = await prisma.comment.findMany({
    where: { docId, type: "SUGGESTION" },
    orderBy: { driveCreatedAt: "desc" },
  });

  logInfo(`[Suggestions:Ext] ${googleDocId}: done — ${merged} merged, ${inserted} inserted, ${skipped} skipped, ${resolved} resolved (${Date.now() - t0}ms)`);

  return { merged, inserted, skipped, resolved, comments };
}

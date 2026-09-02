/**
 * Shared Prisma include clauses and transform for docs.
 */
import { CommentStatus } from "@prisma/client";
import { isThreadRead } from "@/lib/read-state";

/** Labels with their label relation, ordered by position */
export const labelInclude = {
  include: { label: true },
  orderBy: { label: { position: "asc" as const } },
} as const;

/** Prisma include clause: fetches labels + minimal comment fields for count computation */
export const docWithCountsInclude = {
  labels: labelInclude,
  comments: {
    where: {
      OR: [
        { status: CommentStatus.INBOX },
        { resolved: false as const }
      ]
    },
    select: {
      resolved: true,
      status: true,
      readMessageCount: true,
      replyCount: true,
      assignedToMe: true,
      mentionedMeUnreplied: true,
    },
  },
};

/** Prisma include clause: fetches labels + full comments ordered by Google ID */
export const docWithCommentsInclude = {
  labels: labelInclude,
  comments: { orderBy: [{ googleSuggestionId: "asc" as const }, { googleCommentId: "asc" as const }] },
};

/**
 * Clear titles from doc objects before returning them to the client.
 * The client always gets titles and owners through a single path:
 * localStorage cache backed by /api/docs/metadata. That endpoint resolves
 * titles from Drive for accessible docs and from the DB for inaccessible
 * ones (where we store a user-chosen or Gmail-captured title as fallback).
 * Stripping here keeps that flow uniform regardless of source.
 * See docs/local-storage-cache.md.
 */
export function stripServerOnly<T extends { title: string }>(doc: T): T {
  return { ...doc, title: "" };
}

/** Add counts of comments in different states for the docs list page, and strip the raw comments array */
export function withCommentCounts<
  T extends {
    comments: { resolved: boolean; status: string; readMessageCount: number; replyCount: number; assignedToMe: boolean; mentionedMeUnreplied: boolean }[]
  },
>(doc: T) {
  const { comments, ...rest } = doc;
  const isInbox = (c: (typeof comments)[number]) => c.status === CommentStatus.INBOX;
  // "Unread" counts threads with any unread message, not unread messages —
  // the docs table shows a per-thread count.
  const isUnread = (c: (typeof comments)[number]) => !isThreadRead(c);
  return {
    ...rest,
    _count: {
      unreadComments: comments.filter((c) => isInbox(c) && isUnread(c)).length,
      inboxComments: comments.filter(isInbox).length,
      openComments: comments.filter((c) => !c.resolved).length,
      assignedComments: comments.filter((c) => isInbox(c) && c.assignedToMe && !c.resolved).length,
      mentionedComments: comments.filter((c) => isInbox(c) && c.mentionedMeUnreplied && isUnread(c) && !c.resolved).length,
    },
  };
}

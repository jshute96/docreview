/**
 * Shared Prisma include clauses and transform for docs.
 */

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
        { status: "INBOX" as const },
        { resolved: false as const }
      ]
    },
    select: {
      resolved: true,
      status: true,
      isRead: true,
      assignedToMe: true,
      mentionedMeUnreplied: true,
    },
  },
};

/** Prisma include clause: fetches labels + full comments ordered by creation time */
export const docWithCommentsInclude = {
  labels: labelInclude,
  comments: { orderBy: { driveCreatedAt: "asc" as const } },
};

/** Add counts of comments in different states for the docs list page, and strip the raw comments array */
export function withCommentCounts<
  T extends {
    comments: { resolved: boolean; status: string; isRead: boolean; assignedToMe: boolean; mentionedMeUnreplied: boolean }[]
  },
>(doc: T) {
  const { comments, ...rest } = doc;
  const isInbox = (c: (typeof comments)[number]) => c.status === "INBOX";
  return {
    ...rest,
    _count: {
      unreadComments: comments.filter((c) => isInbox(c) && !c.isRead).length,
      inboxComments: comments.filter(isInbox).length,
      openComments: comments.filter((c) => !c.resolved).length,
      assignedComments: comments.filter((c) => isInbox(c) && c.assignedToMe && !c.resolved).length,
      mentionedComments: comments.filter((c) => isInbox(c) && c.mentionedMeUnreplied && !c.isRead && !c.resolved).length,
    },
  };
}

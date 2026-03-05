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
      type: true,
      isThreadAuthor: true,
      iParticipated: true,
      resolved: true,
      status: true,
      isRead: true,
    },
  },
};

/** Prisma include clause: fetches labels + full comments ordered by creation time */
export const docWithCommentsInclude = {
  labels: labelInclude,
  comments: { orderBy: { driveCreatedAt: "asc" as const } },
};

/** Strip raw comments array and replace with computed _count */
export function withCommentCounts<
  T extends {
    role: string;
    comments: { type: string; isThreadAuthor: boolean; iParticipated: boolean; resolved: boolean; status: string; isRead: boolean }[]
  },
>(doc: T) {
  const { comments, ...rest } = doc;
  const inboxFilter = (c: (typeof comments)[number]) =>
    c.status === "INBOX" &&
    (doc.role === "AUTHOR" || c.type === "SUGGESTION" || c.isThreadAuthor || c.iParticipated);
  return {
    ...rest,
    _count: {
      unreadComments: comments.filter((c) => inboxFilter(c) && !c.isRead).length,
      inboxComments: comments.filter(inboxFilter).length,
      openComments: comments.filter((c) => !c.resolved).length,
    },
  };
}

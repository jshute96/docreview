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
      isThreadAuthor: true, 
      iParticipated: true, 
      resolved: true, 
      status: true 
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
    comments: { isThreadAuthor: boolean; iParticipated: boolean; resolved: boolean; status: string }[] 
  },
>(doc: T) {
  const { comments, ...rest } = doc;
  return {
    ...rest,
    _count: {
      inboxComments: comments.filter(
        (c) =>
          c.status === "INBOX" &&
          (doc.role === "AUTHOR" || c.isThreadAuthor || c.iParticipated),
      ).length,
      openComments: comments.filter((c) => !c.resolved).length,
    },
  };
}

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
    where: { status: "ACTIVE" as const },
    select: { isThreadAuthor: true, iParticipated: true },
  },
};

/** Prisma include clause: fetches labels + full comments ordered by creation time */
export const docWithCommentsInclude = {
  labels: labelInclude,
  comments: { orderBy: { driveCreatedAt: "asc" as const } },
};

/** Strip raw comments array and replace with computed _count */
export function withCommentCounts<
  T extends { comments: { isThreadAuthor: boolean; iParticipated: boolean }[] },
>(doc: T) {
  const { comments, ...rest } = doc;
  return {
    ...rest,
    _count: {
      watchedComments: comments.filter(
        (c) => c.isThreadAuthor || c.iParticipated,
      ).length,
      openComments: comments.length,
    },
  };
}

/**
 * Shared Prisma include clause and transform for computing split comment counts
 * (watched vs all active) without fetching full comment data.
 */

/** Prisma include clause: fetches labels + minimal comment fields for count computation */
export const docWithCountsInclude = {
  labels: { 
    include: { label: true },
    orderBy: { label: { position: "asc" as const } },
  },
  comments: {
    where: { status: "ACTIVE" as const },
    select: { isThreadAuthor: true, iParticipated: true },
  },
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

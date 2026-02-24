import { describe, it, expect } from "vitest";
import { withCommentCounts } from "./doc-queries";

describe("withCommentCounts", () => {
  it("counts watched comments (isThreadAuthor or iParticipated)", () => {
    const doc = {
      id: "d1",
      comments: [
        { isThreadAuthor: true, iParticipated: false },
        { isThreadAuthor: false, iParticipated: true },
        { isThreadAuthor: false, iParticipated: false },
        { isThreadAuthor: true, iParticipated: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.watchedComments).toBe(3);
  });

  it("counts all comments as open", () => {
    const doc = {
      id: "d1",
      comments: [
        { isThreadAuthor: false, iParticipated: false },
        { isThreadAuthor: false, iParticipated: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.openComments).toBe(2);
  });

  it("returns zero counts for empty comments", () => {
    const doc = { id: "d1", comments: [] };
    const result = withCommentCounts(doc);
    expect(result._count).toEqual({ watchedComments: 0, openComments: 0 });
  });

  it("strips the comments array from the result", () => {
    const doc = {
      id: "d1",
      title: "Test",
      comments: [{ isThreadAuthor: true, iParticipated: false }],
    };
    const result = withCommentCounts(doc);
    expect(result).toHaveProperty("id", "d1");
    expect(result).toHaveProperty("title", "Test");
    expect(result).not.toHaveProperty("comments");
  });
});

import { describe, it, expect } from "vitest";
import { withCommentCounts } from "./doc-queries";

describe("withCommentCounts", () => {
  it("counts watched comments (status ACTIVE and (isThreadAuthor or iParticipated)) for REVIEWER", () => {
    const doc = {
      id: "d1",
      role: "REVIEWER",
      comments: [
        { isThreadAuthor: true, iParticipated: false, status: "INBOX", resolved: false },
        { isThreadAuthor: false, iParticipated: true, status: "INBOX", resolved: false },
        { isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false },
        { isThreadAuthor: true, iParticipated: true, status: "INBOX", resolved: false },
        // Manual ARCHIVED unresolved thread: should NOT be watched
        { isThreadAuthor: true, iParticipated: true, status: "ARCHIVED", resolved: false },
        // Resolved by someone else: should be watched if status is ACTIVE
        { isThreadAuthor: true, iParticipated: true, status: "INBOX", resolved: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.watchedComments).toBe(4); // 1, 2, 4, 6
  });

  it("counts ALL active comments for AUTHOR", () => {
    const doc = {
      id: "d1",
      role: "AUTHOR",
      comments: [
        { isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false },
        { isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: true },
        { isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.watchedComments).toBe(2); // first 2 are ACTIVE
  });

  it("counts all unresolved comments as open", () => {
    const doc = {
      id: "d1",
      role: "REVIEWER",
      comments: [
        { isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false },
        { isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: false },
        { isThreadAuthor: false, iParticipated: false, status: "MUTED", resolved: false },
        { isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.openComments).toBe(3); // first 3 are unresolved
  });

  it("returns zero counts for empty comments", () => {
    const doc = { id: "d1", role: "REVIEWER", comments: [] };
    const result = withCommentCounts(doc);
    expect(result._count).toEqual({ watchedComments: 0, openComments: 0 });
  });

  it("strips the comments array from the result", () => {
    const doc = {
      id: "d1",
      role: "REVIEWER",
      title: "Test",
      comments: [{ isThreadAuthor: true, iParticipated: false, status: "INBOX", resolved: false }],
    };
    const result = withCommentCounts(doc);
    expect(result).toHaveProperty("id", "d1");
    expect(result).toHaveProperty("title", "Test");
    expect(result).not.toHaveProperty("comments");
  });
});

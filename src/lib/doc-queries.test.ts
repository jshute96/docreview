import { describe, it, expect } from "vitest";
import { withCommentCounts } from "./doc-queries";

describe("withCommentCounts", () => {
  it("counts inbox comments (status INBOX and (isThreadAuthor or iParticipated)) for REVIEWER", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      comments: [
        { type: "COMMENT", isThreadAuthor: true, iParticipated: false, status: "INBOX", resolved: false, isRead: false},
        { type: "COMMENT", isThreadAuthor: false, iParticipated: true, status: "INBOX", resolved: false, isRead: true },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false, isRead: false },
        { type: "COMMENT", isThreadAuthor: true, iParticipated: true, status: "INBOX", resolved: false, isRead: false },
        // Manual ARCHIVED unresolved thread: should NOT be watched
        { type: "COMMENT", isThreadAuthor: true, iParticipated: true, status: "ARCHIVED", resolved: false, isRead: false },
        // Resolved by someone else: should be watched if status is INBOX
        { type: "COMMENT", isThreadAuthor: true, iParticipated: true, status: "INBOX", resolved: true, isRead: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(4); // 1, 2, 4, 6
  });

  it("counts ALL active comments for AUTHOR", () => {
    const doc = {
      docId: "d1",
      role: "AUTHOR",
      comments: [
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false, isRead: false },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: true, isRead: true },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: false, isRead: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(2); // first 2 are INBOX
  });

  it("counts all unresolved comments as open", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      comments: [
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false, isRead: false },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: false, isRead: false },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "MUTED", resolved: false, isRead: false },
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "ARCHIVED", resolved: true, isRead: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.openComments).toBe(3); // first 3 are unresolved
  });

  it("returns zero counts for empty comments", () => {
    const doc = { docId: "d1", role: "REVIEWER", comments: [] };
    const result = withCommentCounts(doc);
    expect(result._count).toEqual({ unreadComments: 0, inboxComments: 0, openComments: 0 });
  });

  it("counts suggestions in inbox/unread for REVIEWER docs", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      comments: [
        // Suggestion: always counts in inbox regardless of isThreadAuthor/iParticipated
        { type: "SUGGESTION", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false, isRead: false },
        // Comment without participation: does NOT count
        { type: "COMMENT", isThreadAuthor: false, iParticipated: false, status: "INBOX", resolved: false, isRead: false },
        // Comment with participation: counts
        { type: "COMMENT", isThreadAuthor: true, iParticipated: false, status: "INBOX", resolved: false, isRead: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(2); // suggestion + participated comment
    expect(result._count.unreadComments).toBe(1); // only the suggestion (comment is isRead)
    expect(result._count.openComments).toBe(3); // all are unresolved
  });

  it("strips the comments array from the result", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      title: "Test",
      comments: [{ type: "COMMENT", isThreadAuthor: true, iParticipated: false, status: "INBOX", resolved: false, isRead: false}],
    };
    const result = withCommentCounts(doc);
    expect(result).toHaveProperty("docId", "d1");
    expect(result).toHaveProperty("title", "Test");
    expect(result).not.toHaveProperty("comments");
  });
});

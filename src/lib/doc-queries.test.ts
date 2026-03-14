import { describe, it, expect } from "vitest";
import { withCommentCounts } from "./doc-queries";

describe("withCommentCounts", () => {
  it("counts all INBOX comments for REVIEWER", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      comments: [
        { status: "INBOX", resolved: false, isRead: false },
        { status: "INBOX", resolved: false, isRead: true },
        { status: "INBOX", resolved: false, isRead: false },
        // Manual ARCHIVED unresolved thread: should NOT count
        { status: "ARCHIVED", resolved: false, isRead: false },
        // Resolved but still INBOX: should count
        { status: "INBOX", resolved: true, isRead: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(4);
    expect(result._count.unreadComments).toBe(2);
  });

  it("counts all INBOX comments for AUTHOR", () => {
    const doc = {
      docId: "d1",
      role: "AUTHOR",
      comments: [
        { status: "INBOX", resolved: false, isRead: false },
        { status: "INBOX", resolved: true, isRead: true },
        { status: "ARCHIVED", resolved: false, isRead: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(2);
  });

  it("counts all unresolved comments as open", () => {
    const doc = {
      docId: "d1",
      comments: [
        { status: "INBOX", resolved: false, isRead: false },
        { status: "ARCHIVED", resolved: false, isRead: false },
        { status: "MUTED", resolved: false, isRead: false },
        { status: "ARCHIVED", resolved: true, isRead: false },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.openComments).toBe(3);
  });

  it("returns zero counts for empty comments", () => {
    const doc = { docId: "d1", comments: [] as { resolved: boolean; status: string; isRead: boolean }[] };
    const result = withCommentCounts(doc);
    expect(result._count).toEqual({ unreadComments: 0, inboxComments: 0, openComments: 0 });
  });

  it("unread counts only unread INBOX comments", () => {
    const doc = {
      docId: "d1",
      comments: [
        { status: "INBOX", resolved: false, isRead: false },
        { status: "INBOX", resolved: false, isRead: false },
        { status: "INBOX", resolved: false, isRead: true },
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(3);
    expect(result._count.unreadComments).toBe(2);
    expect(result._count.openComments).toBe(3);
  });

  it("strips the comments array from the result", () => {
    const doc = {
      docId: "d1",
      title: "Test",
      comments: [{ status: "INBOX", resolved: false, isRead: false }],
    };
    const result = withCommentCounts(doc);
    expect(result).toHaveProperty("docId", "d1");
    expect(result).toHaveProperty("title", "Test");
    expect(result).not.toHaveProperty("comments");
  });
});

import { describe, it, expect } from "vitest";
import { withCommentCounts } from "./doc-queries";

/** Shorthand: creates a comment with defaults for the new fields */
function c(overrides: { status: string; resolved: boolean; isRead: boolean; assignedToMe?: boolean; mentionedMeUnreplied?: boolean }) {
  return { assignedToMe: false, mentionedMeUnreplied: false, ...overrides };
}

describe("withCommentCounts", () => {
  it("counts all INBOX comments for REVIEWER", () => {
    const doc = {
      docId: "d1",
      role: "REVIEWER",
      comments: [
        c({ status: "INBOX", resolved: false, isRead: false }),
        c({ status: "INBOX", resolved: false, isRead: true }),
        c({ status: "INBOX", resolved: false, isRead: false }),
        // Manual ARCHIVED unresolved thread: should NOT count
        c({ status: "ARCHIVED", resolved: false, isRead: false }),
        // Resolved but still INBOX: should count
        c({ status: "INBOX", resolved: true, isRead: true }),
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
        c({ status: "INBOX", resolved: false, isRead: false }),
        c({ status: "INBOX", resolved: true, isRead: true }),
        c({ status: "ARCHIVED", resolved: false, isRead: false }),
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.inboxComments).toBe(2);
  });

  it("counts all unresolved comments as open", () => {
    const doc = {
      docId: "d1",
      comments: [
        c({ status: "INBOX", resolved: false, isRead: false }),
        c({ status: "ARCHIVED", resolved: false, isRead: false }),
        c({ status: "MUTED", resolved: false, isRead: false }),
        c({ status: "ARCHIVED", resolved: true, isRead: false }),
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.openComments).toBe(3);
  });

  it("returns zero counts for empty comments", () => {
    const doc = { docId: "d1", comments: [] as ReturnType<typeof c>[] };
    const result = withCommentCounts(doc);
    expect(result._count).toEqual({
      unreadComments: 0, inboxComments: 0, openComments: 0,
      assignedComments: 0, mentionedComments: 0,
    });
  });

  it("unread counts only unread INBOX comments", () => {
    const doc = {
      docId: "d1",
      comments: [
        c({ status: "INBOX", resolved: false, isRead: false }),
        c({ status: "INBOX", resolved: false, isRead: false }),
        c({ status: "INBOX", resolved: false, isRead: true }),
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
      comments: [c({ status: "INBOX", resolved: false, isRead: false })],
    };
    const result = withCommentCounts(doc);
    expect(result).toHaveProperty("docId", "d1");
    expect(result).toHaveProperty("title", "Test");
    expect(result).not.toHaveProperty("comments");
  });

  it("counts assigned comments: INBOX + assignedToMe + unresolved", () => {
    const doc = {
      docId: "d1",
      comments: [
        c({ status: "INBOX", resolved: false, isRead: false, assignedToMe: true }),
        c({ status: "INBOX", resolved: false, isRead: true, assignedToMe: true }),
        // resolved assigned: should NOT count
        c({ status: "INBOX", resolved: true, isRead: false, assignedToMe: true }),
        // archived assigned: should NOT count
        c({ status: "ARCHIVED", resolved: false, isRead: false, assignedToMe: true }),
        // not assigned: should NOT count
        c({ status: "INBOX", resolved: false, isRead: false }),
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.assignedComments).toBe(2);
  });

  it("counts mentioned comments: INBOX + mentionedMeUnreplied + unread + unresolved", () => {
    const doc = {
      docId: "d1",
      comments: [
        c({ status: "INBOX", resolved: false, isRead: false, mentionedMeUnreplied: true }),
        // read: should NOT count
        c({ status: "INBOX", resolved: false, isRead: true, mentionedMeUnreplied: true }),
        // resolved: should NOT count
        c({ status: "INBOX", resolved: true, isRead: false, mentionedMeUnreplied: true }),
        // archived: should NOT count
        c({ status: "ARCHIVED", resolved: false, isRead: false, mentionedMeUnreplied: true }),
        // not mentioned-unreplied: should NOT count
        c({ status: "INBOX", resolved: false, isRead: false }),
      ],
    };
    const result = withCommentCounts(doc);
    expect(result._count.mentionedComments).toBe(1);
  });
});

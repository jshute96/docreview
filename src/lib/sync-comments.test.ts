import { describe, it, expect, vi, beforeEach } from "vitest";
import { suppressingErrors } from "@/test-utils";

vi.mock("googleapis", () => ({ google: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    comment: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    doc: {
      update: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive", () => ({
  getDriveClient: vi.fn(),
  fetchComments: vi.fn(),
  fetchSuggestions: vi.fn(),
}));

import { syncComments } from "./sync-comments";
import { prisma } from "@/lib/prisma";
import { fetchComments, fetchSuggestions } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

const mockComment = prisma.comment as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};
const mockDoc = prisma.doc as unknown as {
  update: ReturnType<typeof vi.fn>;
};
const mockFetchComments = vi.mocked(fetchComments);
const mockFetchSuggestions = vi.mocked(fetchSuggestions);

// Minimal doc factory — only fields syncComments reads
function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    docId: "d1",
    userId: "u1",
    googleDocId: "gdoc1",
    title: "Test Doc",
    driveUrl: "https://docs.google.com/document/d/gdoc1/edit",
    mimeType: "application/vnd.google-apps.document",
    role: "REVIEWER",
    status: "INBOX",
    isDeleted: false,
    lastModifiedInDrive: new Date("2024-06-01"),
    owner: "Someone",
    createdTimeInDrive: new Date("2024-01-01"),
    addedAt: new Date(),
    commentsLastSyncedAt: null,
    ...overrides,
  } as Doc;
}

const driveAuth = {} as Awaited<ReturnType<typeof import("@/lib/google-drive").getDriveClient>>;

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no existing comments, no suggestions
  mockComment.findMany.mockResolvedValue([]);
  mockComment.createMany.mockResolvedValue({ count: 0 });
  mockComment.update.mockResolvedValue({});
  mockComment.deleteMany.mockResolvedValue({ count: 0 });
  mockDoc.update.mockResolvedValue({});
  mockFetchSuggestions.mockResolvedValue([]);
});

// Helper: a single Drive comment with sensible defaults
function driveComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    resolved: false,
    isThreadAuthor: false,
    iParticipated: false,
    iResolvedIt: false,
    driveCreatedAt: new Date("2024-06-01"),
    driveModifiedAt: new Date("2024-06-10"),
    replyCount: 0,
    ...overrides,
  };
}

// --------------- fetchComments failure ---------------

describe("syncComments error handling", () => {
  it("returns 0 created and no unarchive when fetchComments fails", async () => {
    mockFetchComments.mockRejectedValue(new Error("Drive error"));
    const doc = makeDoc();

    const result = await suppressingErrors(() => syncComments(doc, driveAuth));
    expect(result).toEqual({ created: 0, shouldUnarchive: false, transientError: true });
  });
});

// --------------- isInteresting / shouldUnarchive ---------------

describe("syncComments isInteresting logic", () => {
  // --- New comment cases ---

  it("unarchives for new comment on AUTHOR doc (I'm the doc owner)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchComments.mockResolvedValue([driveComment()]);

    const { shouldUnarchive, created } = await syncComments(doc, driveAuth);
    expect(created).toBe(1);
    expect(shouldUnarchive).toBe(true);
  });

  it("unarchives for new comment where I participated (REVIEWER doc)", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchComments.mockResolvedValue([
      driveComment({ iParticipated: true }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive for new comment on REVIEWER doc where I didn't participate", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchComments.mockResolvedValue([
      driveComment({ iParticipated: false }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive when I resolved it myself", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: true, iResolvedIt: true, iParticipated: true }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("unarchives when resolved but NOT by me (someone else resolved my thread)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: true, iResolvedIt: false }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("unarchives for new comment where isThreadAuthor implies iParticipated", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchComments.mockResolvedValue([
      driveComment({ isThreadAuthor: true, iParticipated: true }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  // --- Existing comment with new replies ---

  it("unarchives when existing comment has new replies and isInteresting", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ replyCount: 3 }),
    ]);

    const { shouldUnarchive, created } = await syncComments(doc, driveAuth);
    expect(created).toBe(0);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive when existing comment has new replies but not interesting", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ replyCount: 3, iParticipated: false }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive when replyCount has not increased", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 3,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ replyCount: 3 }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  // --- MUTED handling ---

  it("does NOT unarchive for MUTED existing comment even with new replies", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 1,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ replyCount: 5 }),
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  // --- Suggestion unarchive ---

  it("unarchives for new suggestion on AUTHOR doc", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([
      { id: "suggest.abc", suggestionType: "EDIT" },
    ]);

    const { shouldUnarchive, created } = await syncComments(doc, driveAuth);
    expect(created).toBe(1);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive for new suggestion on REVIEWER doc", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([
      { id: "suggest.abc", suggestionType: "INSERT" },
    ]);

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive for existing suggestion", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([
      { id: "suggest.abc", suggestionType: "DELETE" },
    ]);
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleCommentId: "suggest.abc", suggestionType: "DELETE" }]);

    const { shouldUnarchive, created } = await syncComments(doc, driveAuth);
    expect(created).toBe(0);
    expect(shouldUnarchive).toBe(false);
  });
});

// --------------- Comment status assignment ---------------

describe("syncComments comment status", () => {
  it("creates new unresolved comment as INBOX", async () => {
    mockFetchComments.mockResolvedValue([driveComment()]);

    await syncComments(makeDoc(), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("creates new resolved comment as ARCHIVED", async () => {
    mockFetchComments.mockResolvedValue([driveComment({ resolved: true })]);

    await syncComments(makeDoc(), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("ARCHIVED");
  });

  it("archives existing comment when I resolved it", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 0,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: true, iResolvedIt: true }),
    ]);

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("sets existing comment to INBOX when resolved by someone else", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 0,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: true, iResolvedIt: false }),
    ]);

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("preserves MUTED status — does not change it to INBOX or ARCHIVED", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 0,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: true, iResolvedIt: true }),
    ]);

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    // MUTED path updates Drive fields but not status
    expect(updateCall.data.status).toBeUndefined();
  });

  it("preserves manual ARCHIVED status if no new activity", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", 
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ resolved: false, replyCount: 0, driveModifiedAt: modDate }),
    ]);

    await syncComments(makeDoc(), driveAuth);

    // No-op detection should mean no update, or at least status remains ARCHIVED if updated
    const updateCall = mockComment.update.mock.calls[0]?.[0];
    if (updateCall && updateCall.data.status) {
      expect(updateCall.data.status).toBe("ARCHIVED");
    }
  });

  it("wakes up ARCHIVED comment if new reply added", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", 
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchComments.mockResolvedValue([
      driveComment({ 
        resolved: false, 
        replyCount: 1, 
        driveModifiedAt: new Date("2024-06-10T11:00:00Z") 
      }),
    ]);

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });
});

// --------------- Suggestion resolution ---------------

describe("syncComments suggestion resolution", () => {
  it("marks suggestion as resolved when no longer in Docs API", async () => {
    const doc = makeDoc();
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([]); // suggestion disappeared
    mockComment.findMany
      .mockResolvedValueOnce([])                                                            // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleCommentId: "suggest.abc", suggestionType: "EDIT" }]) // existingSuggestions
      .mockResolvedValueOnce([{                                                             // activeSuggestions
        commentId: "cr1", googleCommentId: "suggest.abc", resolved: false, status: "INBOX",
      }]);

    await syncComments(doc, driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.resolved).toBe(true);
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("preserves MUTED status when marking suggestion as resolved", async () => {
    const doc = makeDoc();
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([]);
    mockComment.findMany
      .mockResolvedValueOnce([])                                                            // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleCommentId: "suggest.abc", suggestionType: "EDIT" }])
      .mockResolvedValueOnce([{
        commentId: "cr1", googleCommentId: "suggest.abc", resolved: false, status: "MUTED",
      }]);

    await syncComments(doc, driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.resolved).toBe(true);
    expect(updateCall.data.status).toBe("MUTED");
  });

  it("skips suggestion sync for non-Docs MIME types", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    mockFetchComments.mockResolvedValue([]);

    await syncComments(doc, driveAuth);

    expect(mockFetchSuggestions).not.toHaveBeenCalled();
  });

  it("skips AAAB-prefixed IDs during suggestion resolution check", async () => {
    const doc = makeDoc();
    mockFetchComments.mockResolvedValue([]);
    mockFetchSuggestions.mockResolvedValue([]);
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([])  // existingSuggestions
      .mockResolvedValueOnce([{
        commentId: "cr1", googleCommentId: "AAAB0xyz", resolved: false, status: "INBOX",
      }]);

    await syncComments(doc, driveAuth);

    // The AAAB entry should be skipped — no update call
    expect(mockComment.update).not.toHaveBeenCalled();
  });
});

// --------------- Deleted comment cleanup ---------------

describe("syncComments deleted comment cleanup", () => {
  it("deletes DB records for comments no longer returned by Drive", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    // DB has two comments, but Drive only returns one of them
    mockComment.findMany.mockResolvedValueOnce([
      { commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 0 },
      { commentId: "cr2", docId: "d1", googleCommentId: "c2", status: "ARCHIVED", replyCount: 3 },
    ]);
    mockFetchComments.mockResolvedValue([driveComment({ id: "c1" })]);
    mockComment.deleteMany.mockResolvedValue({ count: 1 });

    await syncComments(doc, driveAuth);

    expect(mockComment.deleteMany).toHaveBeenCalledWith({
      where: { commentId: { in: ["cr2"] } },
    });
  });

  it("does not call deleteMany when all DB comments are still in Drive", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    mockComment.findMany.mockResolvedValueOnce([
      { commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 0 },
    ]);
    mockFetchComments.mockResolvedValue([driveComment({ id: "c1" })]);

    await syncComments(doc, driveAuth);

    expect(mockComment.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes MUTED comments that were deleted from Drive", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    mockComment.findMany.mockResolvedValueOnce([
      { commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 0 },
    ]);
    mockFetchComments.mockResolvedValue([]); // Drive returns nothing
    mockComment.deleteMany.mockResolvedValue({ count: 1 });

    await syncComments(doc, driveAuth);

    expect(mockComment.deleteMany).toHaveBeenCalledWith({
      where: { commentId: { in: ["cr1"] } },
    });
  });
});

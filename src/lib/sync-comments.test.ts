import { describe, it, expect, vi, beforeEach } from "vitest";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/lib/prisma", () => {
  const comment = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    delete: vi.fn(),
  };
  const doc = { update: vi.fn() };
  return {
    prisma: {
      comment,
      doc,
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ comment, doc, $executeRaw: vi.fn() })),
    },
  };
});
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return {
    getDriveClient: vi.fn(),
    fetchCommentData: vi.fn(),
    fetchDocData: vi.fn(),
    fetchThreadDetail: vi.fn(),
    // Pure helpers — use real implementations so error-code checks work
    isDriveErrorCode: actual.isDriveErrorCode,
    getDriveErrorCode: actual.getDriveErrorCode,
  };
});

import { syncComments, syncSingleComment } from "./sync-comments";
import { prisma } from "@/lib/prisma";
import { fetchCommentData, fetchDocData, fetchThreadDetail } from "@/lib/google-drive";
import { computeSuggestionHash } from "./suggestion-hash";
import { SuggestionType, type Doc } from "@prisma/client";

const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockDoc = prisma.doc as unknown as {
  update: ReturnType<typeof vi.fn>;
};
const mockFetchCommentData = vi.mocked(fetchCommentData);
const mockFetchDocData = vi.mocked(fetchDocData);

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
    accessState: "OK",
    lastModifiedInDrive: new Date("2024-06-01"),
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
  mockComment.delete.mockResolvedValue({});
  mockDoc.update.mockResolvedValue({});
  mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null });
});

// Helper: a DB comment record (from Prisma findMany) with sensible defaults
function dbComment(overrides: Record<string, unknown> = {}) {
  // Tests express stored read state with the `isRead` boolean the UI still
  // uses; it's translated to the stored message count here (see
  // src/lib/read-state.ts). Override `readMessageCount` directly to model a
  // partially-read thread.
  const { isRead, ...rest } = overrides;
  const replyCount = (rest.replyCount as number | undefined) ?? 0;
  return {
    commentId: "cr1", docId: "d1", googleCommentId: "c1",
    type: "COMMENT", suggestionType: null,
    resolved: false, isThreadAuthor: false, isReplyAuthor: false,
    readMessageCount: isRead ? replyCount + 1 : 0, isStarred: false,
    assignedToMe: false, mentionedMe: false, mentionedMeUnreplied: false,
    status: "INBOX", driveCreatedAt: new Date("2024-06-01"),
    driveModifiedAt: new Date("2024-06-10"), replyCount,
    createdAt: new Date(), updatedAt: new Date(),
    ...rest,
  };
}

// Helper: a single Drive comment with sensible defaults
function driveComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    resolved: false,
    isThreadAuthor: false,
    isReplyAuthor: false,
    iResolvedIt: false,
    isRead: false,
    assignedToMe: false,
    mentionedMe: false,
    mentionedMeUnreplied: false,
    driveCreatedAt: new Date("2024-06-01"),
    driveModifiedAt: new Date("2024-06-10"),
    replyCount: 0,
    replyAuthorMeFlags: [] as boolean[],
    replyMentionedMeFlags: [] as boolean[],
    replyAssignedToMeFlags: [] as boolean[],
    ...overrides,
  };
}

// --------------- fetchComments failure ---------------

describe("syncComments error handling", () => {
  it("returns 0 created and no unarchive when fetchComments fails", async () => {
    mockFetchCommentData.mockRejectedValue(new Error("Drive error"));
    const doc = makeDoc();

    const result = await suppressingErrors(() => syncComments(doc, driveAuth));
        expect(result).toEqual({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, transientError: true
    });
  });
});

// --------------- isInteresting / shouldUnarchive ---------------

describe("syncComments isInteresting logic", () => {
  // --- New comment cases ---

  it("unarchives for new comment on AUTHOR doc (I'm the doc owner)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment()] });

    const { shouldUnarchive, commentsCreated: created } = await syncComments(doc, driveAuth);
    expect(created).toBe(1);
    expect(shouldUnarchive).toBe(true);
  });

  it("unarchives for new comment where I participated (REVIEWER doc)", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ isReplyAuthor: true }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive for new comment on REVIEWER doc where I didn't participate", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ isReplyAuthor: false }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive when I resolved it myself", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: true, isReplyAuthor: true }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive for new already-resolved comment even on AUTHOR doc", async () => {
    // New resolved comments always start ARCHIVED regardless of who resolved them
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: false }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive for new comment on AUTHOR doc when isRead (my own comment)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment({ isRead: true })] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive for new comment where I participated when isRead", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ isReplyAuthor: true, isRead: true }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("unarchives for new comment where isThreadAuthor (REVIEWER doc)", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ isThreadAuthor: true }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  // --- Existing comment with new replies ---

  it("unarchives when existing INBOX comment on AUTHOR doc has new replies", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 3, replyAuthorMeFlags: [false, false, false] }),
    ] });

    const { shouldUnarchive, commentsCreated: created } = await syncComments(doc, driveAuth);
    expect(created).toBe(0);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive when existing comment has new replies but not relevant (REVIEWER, no participation)", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 1,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 3, isReplyAuthor: false, replyAuthorMeFlags: [false, false, false] }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive when existing INBOX comment has new replies but isRead (my own reply)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 3, isRead: true, replyAuthorMeFlags: [false, true, true] }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive when replyCount has not increased", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 3,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 3 }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  // --- MUTED handling ---

  it("does NOT unarchive for MUTED existing comment even with new replies", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 1,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 5 }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  // --- Suggestion unarchive ---

  it("unarchives for new suggestion on AUTHOR doc", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [
      { id: "suggest.abc", suggestionType: "EDIT", insertedText: "new", deletedText: "old" },
    ], suggestionContent: {}, documentText: null });

    const { shouldUnarchive, suggestionsCreated } = await syncComments(doc, driveAuth);
    expect(suggestionsCreated).toBe(1);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive for new suggestion on REVIEWER doc", async () => {
    const doc = makeDoc({ role: "REVIEWER" });
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [
      { id: "suggest.abc", suggestionType: "INSERT", insertedText: "added text", deletedText: "" },
    ], suggestionContent: {}, documentText: null });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  it("does NOT unarchive for existing suggestion", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [
      { id: "suggest.abc", suggestionType: "DELETE", insertedText: "", deletedText: "removed text" },
    ], suggestionContent: {}, documentText: null });
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleSuggestionId: "suggest.abc", suggestionType: "DELETE", suggestionContentHash: null }]);

    const { shouldUnarchive, suggestionsCreated } = await syncComments(doc, driveAuth);
    expect(suggestionsCreated).toBe(0);
    expect(shouldUnarchive).toBe(false);
  });
});

// --------------- Comment status assignment ---------------

describe("syncComments comment status", () => {
  it("creates new unresolved comment as ARCHIVED on REVIEWER doc when not participating", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment()] });

    await syncComments(makeDoc(), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("ARCHIVED");
  });

  it("creates new unresolved comment as INBOX on AUTHOR doc", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment()] });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("creates new unresolved comment as INBOX when isReplyAuthor", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment({ isReplyAuthor: true })] });

    await syncComments(makeDoc(), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("creates new resolved comment as ARCHIVED", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment({ resolved: true })] });

    await syncComments(makeDoc(), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("ARCHIVED");
  });

  it("archives existing comment when I resolved it", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 0,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: true }),
    ] });

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("sets existing comment to INBOX when resolved by someone else on AUTHOR doc", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 0,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: false }),
    ] });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("preserves status when resolved by someone else on REVIEWER doc without participation", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 0,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: false }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("preserves MUTED status — does not change it to INBOX or ARCHIVED", async () => {
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 0,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: true, iResolvedIt: true }),
    ] });

    await syncComments(makeDoc(), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    // MUTED path preserves existing status
    expect(updateCall.data.status).toBe("MUTED");
  });

  it("preserves manual ARCHIVED status if no new activity", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ resolved: false, replyCount: 0, driveModifiedAt: modDate }),
    ] });

    await syncComments(makeDoc(), driveAuth);

    // No-op detection should mean no update, or at least status remains ARCHIVED if updated
    const updateCall = mockComment.update.mock.calls[0]?.[0];
    if (updateCall && updateCall.data.status) {
      expect(updateCall.data.status).toBe("ARCHIVED");
    }
  });

  it("wakes up ARCHIVED comment on AUTHOR doc if new reply added", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: false,
        replyCount: 1,
        replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z")
      }),
    ] });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("preserves ARCHIVED on REVIEWER doc with new reply when not participating", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: false,
        replyCount: 1,
        replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z")
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });
});

// --------------- Self-reply detection (rule 5 exception) ---------------

describe("syncComments self-reply detection", () => {
  it("does NOT move own thread to INBOX when only I replied", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        isThreadAuthor: true, isReplyAuthor: true,
        replyCount: 1, replyAuthorMeFlags: [true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("moves own thread to INBOX when someone else replied", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        isThreadAuthor: true, isReplyAuthor: true,
        replyCount: 2, replyAuthorMeFlags: [true, false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("moves to INBOX when I replied on someone else's thread (rule 6)", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        isThreadAuthor: false, isReplyAuthor: true,
        replyCount: 2, replyAuthorMeFlags: [true, true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });
});

// --------------- @-mention detection (rule 2) ---------------

describe("syncComments @-mention detection", () => {
  it("new comment mentioning me → INBOX even on REVIEWER doc with no participation", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ mentionedMe: true, isReplyAuthor: false }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("new resolved comment mentioning me → INBOX (mention overrides resolved)", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ mentionedMe: true, resolved: true }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("new comment with mention in reply → INBOX", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ replyCount: 1, replyMentionedMeFlags: [true], replyAuthorMeFlags: [false] }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("existing MUTED comment → INBOX when new reply mentions me", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        replyMentionedMeFlags: [false, true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("existing MUTED comment stays MUTED when no new reply mentions me", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        replyMentionedMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    // MUTED path preserves existing status
    expect(updateCall.data.status).toBe("MUTED");
  });

  it("@-mention in new reply unarchives the document", async () => {
    const doc = makeDoc({ role: "REVIEWER", status: "ARCHIVED" });
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        replyCount: 1,
        replyAuthorMeFlags: [false],
        replyMentionedMeFlags: [true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("new resolved comment with @-mention triggers shouldUnarchive", async () => {
    const doc = makeDoc({ role: "REVIEWER", status: "ARCHIVED" });
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ mentionedMe: true, resolved: true }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("@-mention breaking MUTED triggers shouldUnarchive", async () => {
    const doc = makeDoc({ role: "REVIEWER", status: "ARCHIVED" });
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        replyCount: 1,
        replyAuthorMeFlags: [false],
        replyMentionedMeFlags: [true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });
});

// --------------- assigned-to-me detection ---------------

describe("syncComments assigned-to-me detection", () => {
  it("new comment assigned to me → INBOX even on REVIEWER doc with no participation", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ assignedToMe: true, isReplyAuthor: false }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("new resolved comment assigned to me → INBOX (assignment overrides resolved)", async () => {
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({ assignedToMe: true, resolved: true }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const createCall = mockComment.createMany.mock.calls[0][0];
    expect(createCall.data[0].status).toBe("INBOX");
  });

  it("existing MUTED comment → INBOX when new reply assigns me", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        assignedToMe: true,
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        replyAssignedToMeFlags: [false, true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("existing MUTED comment stays MUTED when assigned but no new assignment reply", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        assignedToMe: true,
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        replyAssignedToMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("MUTED");
  });

  it("assignment in new reply breaking MUTED triggers shouldUnarchive", async () => {
    const doc = makeDoc({ role: "REVIEWER", status: "ARCHIVED" });
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        assignedToMe: true,
        replyCount: 1,
        replyAuthorMeFlags: [false],
        replyAssignedToMeFlags: [true],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("existing ARCHIVED comment where I was assigned, new activity → INBOX", async () => {
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 1, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        assignedToMe: true,
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        replyAssignedToMeFlags: [false, false], // not a new assignment, just new activity
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });
});

// --------------- shouldUnarchive status-based rules ---------------

describe("syncComments shouldUnarchive doc-level rules", () => {
  it("unarchives when existing comment transitions from ARCHIVED to INBOX", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    const modDate = new Date("2024-06-10T10:00:00Z");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED",
      resolved: false, replyCount: 0, driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        replyCount: 1, replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-10T11:00:00Z"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("unarchives when INBOX comment resolved by someone else", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX",
      resolved: false, replyCount: 0, driveModifiedAt: new Date("2024-06-10"),
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: true, iResolvedIt: false,
        replyCount: 1, replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-11"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive when INBOX comment resolved by me", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX",
      resolved: false, replyCount: 0, driveModifiedAt: new Date("2024-06-10"),
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: true, iResolvedIt: true,
        replyCount: 1, replyAuthorMeFlags: [true],
        driveModifiedAt: new Date("2024-06-11"),
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });
});

// --------------- Suggestion resolution ---------------

describe("syncComments suggestion resolution", () => {
  it("marks suggestion as resolved when no longer in Docs API", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null }); // suggestion disappeared
    mockComment.findMany
      .mockResolvedValueOnce([])                                                            // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleSuggestionId: "suggest.abc", suggestionType: "EDIT", suggestionContentHash: null }]) // existingSuggestions
      .mockResolvedValueOnce([{                                                             // activeSuggestions
        commentId: "cr1", googleSuggestionId: "suggest.abc", resolved: false, status: "INBOX",
      }]);

    await syncComments(doc, driveAuth);

    // INBOX suggestions are batch-resolved via updateMany with status → ARCHIVED
    const updateManyCall = mockComment.updateMany.mock.calls[0][0];
    expect(updateManyCall.data.resolved).toBe(true);
    expect(updateManyCall.data.status).toBe("ARCHIVED");
  });

  it("preserves MUTED status when marking suggestion as resolved", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null });
    mockComment.findMany
      .mockResolvedValueOnce([])                                                            // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleSuggestionId: "suggest.abc", suggestionType: "EDIT", suggestionContentHash: null }])
      .mockResolvedValueOnce([{
        commentId: "cr1", googleSuggestionId: "suggest.abc", resolved: false, status: "MUTED",
      }]);

    await syncComments(doc, driveAuth);

    // MUTED suggestions are batch-resolved via updateMany without changing status
    const updateManyCall = mockComment.updateMany.mock.calls[0][0];
    expect(updateManyCall.data.resolved).toBe(true);
    expect(updateManyCall.data.status).toBeUndefined();
  });

  it("skips suggestion sync for non-Docs MIME types", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    mockFetchCommentData.mockResolvedValue({ comments: [] });

    await syncComments(doc, driveAuth);

    expect(mockFetchDocData).not.toHaveBeenCalled();
  });

  it("does not resolve suggestions without googleSuggestionId", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null });
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([])  // existingSuggestions
      .mockResolvedValueOnce([]); // activeSuggestions — query filters to googleSuggestionId != null

    await syncComments(doc, driveAuth);

    // The Prisma query for active suggestions filters to googleSuggestionId != null,
    // so rows without one are never candidates for resolution.
    const findManyCall = mockComment.findMany.mock.calls[2][0];
    expect(findManyCall.where.googleSuggestionId).toEqual({ not: null });
    expect(mockComment.updateMany).not.toHaveBeenCalled();
  });
});

// --------------- Deleted comment cleanup ---------------

// --------------- syncDocsSuggestions partner merge ---------------
//
// When the Docs API path finds an existing row by googleSuggestionId but that
// row has no googleCommentId, and there's a unique disco-only row with the
// same content hash, the two are merged into one.

describe("syncDocsSuggestions partner merge", () => {
  const driveSuggestion = {
    id: "suggest.abc",
    suggestionType: SuggestionType.INSERT,
    deletedText: "",
    insertedText: "new text",
  };
  const expectedHash = () => computeSuggestionHash("INSERT", "", "new text");

  it("merges a suggestion-only existing row into a unique disco-only partner", async () => {
    const doc = makeDoc();
    const hash = expectedHash();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({
      suggestions: [driveSuggestion],
      suggestionContent: {},
      documentText: null,
    });
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([    // allExisting
        { commentId: "sug", googleSuggestionId: "suggest.abc", googleCommentId: null,
          suggestionContentHash: hash, suggestionType: "INSERT" },
        { commentId: "disco", googleSuggestionId: null, googleCommentId: "AAAB0disco",
          suggestionContentHash: hash, suggestionType: "INSERT" },
      ])
      .mockResolvedValueOnce([    // activeSuggestions — disco row now has the merged googleSuggestionId
        { commentId: "disco", googleSuggestionId: "suggest.abc", resolved: false, status: "INBOX" },
      ]);

    await syncComments(doc, driveAuth);

    // The suggestion-only row was deleted; googleSuggestionId was salvaged onto the disco row
    expect(mockComment.delete).toHaveBeenCalledWith({ where: { commentId: "sug" } });
    expect(mockComment.update).toHaveBeenCalledWith({
      where: { commentId: "disco" },
      data: { googleSuggestionId: "suggest.abc" },
    });
  });

  it("does NOT partner-merge when the only hash candidate also lacks googleCommentId", async () => {
    const doc = makeDoc();
    const hash = expectedHash();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({
      suggestions: [driveSuggestion],
      suggestionContent: {},
      documentText: null,
    });
    mockComment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { commentId: "sug", googleSuggestionId: "suggest.abc", googleCommentId: null,
          suggestionContentHash: hash, suggestionType: "INSERT" },
        // Candidate has no IDs at all — defensive filter rejects
        { commentId: "ghost", googleSuggestionId: null, googleCommentId: null,
          suggestionContentHash: hash, suggestionType: "INSERT" },
      ])
      .mockResolvedValueOnce([
        { commentId: "sug", googleSuggestionId: "suggest.abc", resolved: false, status: "INBOX" },
      ]);

    await syncComments(doc, driveAuth);

    expect(mockComment.delete).not.toHaveBeenCalled();
  });

  it("keeps maps consistent: a second same-hash suggestion does not clobber the merged partner", async () => {
    // Two Docs-API suggestions with the same content hash: the first triggers a
    // partner merge (into `disco`), the second must NOT re-match `disco` via
    // byContentHash and overwrite its googleSuggestionId. Instead it should
    // insert a new row (no matching partner left in the map).
    const doc = makeDoc();
    const hash = expectedHash();
    const secondSuggestion = { ...driveSuggestion, id: "suggest.def" };
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({
      suggestions: [driveSuggestion, secondSuggestion],
      suggestionContent: {},
      documentText: null,
    });
    mockComment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { commentId: "sug", googleSuggestionId: "suggest.abc", googleCommentId: null,
          suggestionContentHash: hash, suggestionType: "INSERT" },
        { commentId: "disco", googleSuggestionId: null, googleCommentId: "AAAB0disco",
          suggestionContentHash: hash, suggestionType: "INSERT" },
      ])
      .mockResolvedValueOnce([
        { commentId: "disco", googleSuggestionId: "suggest.abc", resolved: false, status: "INBOX" },
      ]);

    await syncComments(doc, driveAuth);

    // Only the first merge assigns googleSuggestionId onto disco; the second
    // suggestion must not update disco again (that would clobber the ID).
    const updateCalls = mockComment.update.mock.calls.map((c) => c[0]);
    const updatesOnDisco = updateCalls.filter((a) => a.where?.commentId === "disco");
    expect(updatesOnDisco).toHaveLength(1);
    expect(updatesOnDisco[0].data).toEqual({ googleSuggestionId: "suggest.abc" });

    // The second suggestion should have gone into the create batch (new row).
    expect(mockComment.createMany).toHaveBeenCalled();
    const created = mockComment.createMany.mock.calls[0][0].data;
    expect(created.some((c: { googleSuggestionId?: string }) => c.googleSuggestionId === "suggest.def")).toBe(true);
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
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment({ id: "c1" })] });
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
    mockFetchCommentData.mockResolvedValue({ comments: [driveComment({ id: "c1" })] });

    await syncComments(doc, driveAuth);

    expect(mockComment.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes MUTED comments that were deleted from Drive", async () => {
    const doc = makeDoc({ mimeType: "application/vnd.google-apps.spreadsheet" });
    mockComment.findMany.mockResolvedValueOnce([
      { commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 0 },
    ]);
    mockFetchCommentData.mockResolvedValue({ comments: [] }); // Drive returns nothing
    mockComment.deleteMany.mockResolvedValue({ count: 1 });

    await syncComments(doc, driveAuth);

    expect(mockComment.deleteMany).toHaveBeenCalledWith({
      where: { commentId: { in: ["cr1"] } },
    });
  });
});

// --------------- read tracking (readMessageCount) ---------------

describe("syncComments read tracking", () => {
  /** The readMessageCount written by the single update call. */
  function updatedReadCount() {
    return mockComment.update.mock.calls[0][0].data.readMessageCount;
  }

  it("seeds a new comment as fully read when I posted last", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ isThreadAuthor: true, replyCount: 2, replyAuthorMeFlags: [false, true] })],
    });

    await syncComments(makeDoc(), driveAuth);

    // My comment, their reply, my reply — all 3 messages read.
    expect(mockComment.createMany.mock.calls[0][0].data[0].readMessageCount).toBe(3);
  });

  it("seeds a new comment as fully unread when I never posted", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ replyCount: 2, replyAuthorMeFlags: [false, false] })],
    });

    await syncComments(makeDoc(), driveAuth);

    expect(mockComment.createMany.mock.calls[0][0].data[0].readMessageCount).toBe(0);
  });

  it("seeds partial read state through my last reply", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ replyCount: 3, replyAuthorMeFlags: [true, false, false] })],
    });

    await syncComments(makeDoc(), driveAuth);

    // Their comment + my reply read; the two replies after mine are not.
    expect(mockComment.createMany.mock.calls[0][0].data[0].readMessageCount).toBe(2);
  });

  it("leaves the read count alone when someone else replies, so only new replies are unread", async () => {
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 2, readMessageCount: 3 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 4,
        replyAuthorMeFlags: [false, false, false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    // Was 3 of 3; now 3 of 5 — exactly the two new replies are unread.
    expect(updatedReadCount()).toBe(3);
  });

  it("keeps a manual mark-unread across a later reply", async () => {
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 1, readMessageCount: 0 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(updatedReadCount()).toBe(0);
  });

  it("marks the thread fully read when my own reply is the latest activity", async () => {
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 1, readMessageCount: 0 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        isRead: true, // Drive-derived: I authored the last reply
        replyAuthorMeFlags: [false, true],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(updatedReadCount()).toBe(3);
  });

  it("marks the last message unread when a thread changes without new replies", async () => {
    // Someone edited a message or deleted a reply: activity we can't localize,
    // so the thread resurfaces as unread.
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 2, readMessageCount: 3 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(updatedReadCount()).toBe(2);
  });

  it("clamps a stored count that exceeds the thread after replies are deleted", async () => {
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 4, readMessageCount: 5 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    // Clamped to 3, then the no-new-replies rule leaves the last message unread.
    expect(updatedReadCount()).toBe(2);
  });
});

// --------------- self-edit (edit/delete made from Docreview) ---------------

describe("syncSingleComment selfEdited", () => {
  const thread = { id: "c1", author: "A", fromMe: true, content: "x", createdTime: "", resolved: false, replies: [] };

  /** The user edited their own comment: Drive's modifiedTime moves, nothing else does. */
  function editedOnly() {
    vi.mocked(fetchThreadDetail).mockResolvedValue({
      comment: driveComment({ driveModifiedAt: new Date("2024-06-20"), isRead: false }),
      thread,
    } as unknown as Awaited<ReturnType<typeof fetchThreadDetail>>);
  }

  it("leaves an archived comment archived and still read", async () => {
    editedOnly();
    mockComment.findFirst.mockResolvedValue(dbComment({ status: "ARCHIVED", isRead: true }));

    await syncSingleComment(makeDoc({ role: "AUTHOR" }), "c1", driveAuth, { selfEdited: true });

    const data = mockComment.update.mock.calls[0][0].data;
    expect(data.status).toBe("ARCHIVED");
    expect(data.readMessageCount).toBe(1); // still fully read (1 of 1 messages)
    // The new timestamp is still recorded, so the next full sync sees no activity.
    expect(data.driveModifiedAt).toEqual(new Date("2024-06-20"));
  });

  it("moves the same comment to INBOX without the flag — the flag is what differs", async () => {
    editedOnly();
    mockComment.findFirst.mockResolvedValue(dbComment({ status: "ARCHIVED", isRead: true }));

    await syncSingleComment(makeDoc({ role: "AUTHOR" }), "c1", driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
  });

  // Someone else replies while the user is saving their own edit. That reply is
  // real activity and must survive — this is the case a "restore the old status
  // afterwards" approach would have clobbered.
  it("still reacts to replies that arrive from someone else in the same window", async () => {
    vi.mocked(fetchThreadDetail).mockResolvedValue({
      comment: driveComment({
        driveModifiedAt: new Date("2024-06-20"),
        replyCount: 1,
        isRead: false,
        replyAuthorMeFlags: [false],
        replyMentionedMeFlags: [true],
      }),
      thread,
    } as unknown as Awaited<ReturnType<typeof fetchThreadDetail>>);
    mockComment.findFirst.mockResolvedValue(dbComment({ status: "ARCHIVED", isRead: true, replyCount: 0 }));

    await syncSingleComment(makeDoc({ role: "AUTHOR" }), "c1", driveAuth, { selfEdited: true });

    const data = mockComment.update.mock.calls[0][0].data;
    expect(data.status).toBe("INBOX");
    // The head comment stays read and their reply is the one unread message.
    expect(data.readMessageCount).toBe(1);
    expect(data.replyCount).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { suppressingErrors } from "@/test-utils";
import { isThreadRead, noTombstones } from "@/lib/read-state";

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
import { ExtCommentType } from "@/lib/extension-wire";
import { CommentStatus, SuggestionType, type Doc } from "@prisma/client";

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
  // uses; it's translated to the stored slot boundary here (see
  // src/lib/read-state.ts). Override `readSlotCount` directly to model a
  // partially-read thread.
  //
  // `replySlotCount` defaults to `replyCount`, which is the truth for any
  // thread that has never had a reply deleted — override it (with a matching
  // `replyDeleted` on the Drive side) to model one that has.
  const { isRead, ...rest } = overrides;
  const replyCount = (rest.replyCount as number | undefined) ?? 0;
  const replySlotCount = (rest.replySlotCount as number | undefined) ?? replyCount;
  return {
    commentId: "cr1", docId: "d1", googleCommentId: "c1",
    type: "COMMENT", suggestionType: null,
    resolved: false, isThreadAuthor: false, isReplyAuthor: false,
    readSlotCount: isRead ? replySlotCount + 1 : 0, isStarred: false,
    readMessageCount: isRead ? replyCount + 1 : 0,
    assignedToMe: false, mentionedMe: false, mentionedMeUnreplied: false,
    status: "INBOX", driveCreatedAt: new Date("2024-06-01"),
    driveModifiedAt: new Date("2024-06-10"), replyCount, replySlotCount,
    createdAt: new Date(), updatedAt: new Date(),
    ...rest,
  };
}

// Helper: a single Drive comment with sensible defaults
function driveComment(overrides: Record<string, unknown> = {}) {
  const replyCount = (overrides.replyCount as number | undefined) ?? 0;
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
    // No deleted replies unless a test says otherwise, so slot space and
    // render space coincide — the shape of every thread before someone
    // deletes something in it.
    replySlotCount: replyCount,
    replyDeleted: noTombstones(replyCount),
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1, replySlotCount: 1,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 1, replySlotCount: 1,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 1, replySlotCount: 1,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 3, replySlotCount: 3,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 1, replySlotCount: 1,
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

  it("creates a Docs-API suggestion as unread", async () => {
    // The Docs API supplies no reply or authorship data, so the row is one
    // unread message. Both read counts default to 0, which is exactly that —
    // the reason the cache stores a *read* count rather than an unread one.
    const doc = makeDoc({ role: "AUTHOR" });
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [
      { id: "suggest.abc", suggestionType: "INSERT", insertedText: "added", deletedText: "" },
    ], suggestionContent: {}, documentText: null });

    await syncComments(doc, driveAuth);

    const created = mockComment.createMany.mock.calls
      .flatMap((call) => call[0].data)
      .find((r: { googleSuggestionId?: string }) => r.googleSuggestionId === "suggest.abc");
    expect(isThreadRead({ readMessageCount: created.readMessageCount ?? 0, replyCount: 0 })).toBe(false);
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX", replyCount: 0, replySlotCount: 0,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 0, replySlotCount: 0,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "ARCHIVED", replyCount: 0, replySlotCount: 0,
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
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "MUTED", replyCount: 0, replySlotCount: 0,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 1, replySlotCount: 1, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: modDate,
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
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: new Date("2024-06-10"),
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

  // The resolve is activity worth surfacing exactly once. Testing the standing
  // resolved state instead would re-unarchive on every sync, so a doc with a
  // thread someone else resolved could never be archived.
  it("does NOT unarchive again on a later sync of an already-resolved INBOX comment", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    const modDate = new Date("2024-06-11");
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX",
      resolved: true, replyCount: 1, replySlotCount: 1, readSlotCount: 0, readMessageCount: 0,
      driveModifiedAt: modDate,
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: true, iResolvedIt: false,
        replyCount: 1, replyAuthorMeFlags: [false],
        driveModifiedAt: modDate,
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(false);
  });

  // The rule-3 test above also adds a reply, so rule 2 alone would carry it. This
  // one isolates rule 3: the reply count is unchanged and the only thing that
  // moved is `resolved`.
  it("unarchives on a bare resolve by someone else, with no new replies (rule 3 alone)", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX",
      resolved: false, replyCount: 1, replySlotCount: 1, readSlotCount: 0, readMessageCount: 0,
      driveModifiedAt: new Date("2024-06-10"),
    }]);
    mockFetchCommentData.mockResolvedValue({ comments: [
      driveComment({
        resolved: true, iResolvedIt: false,
        replyCount: 1, replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-11"), // the resolve bumps modifiedTime
      }),
    ] });

    const { shouldUnarchive } = await syncComments(doc, driveAuth);
    expect(shouldUnarchive).toBe(true);
  });

  it("does NOT unarchive when INBOX comment resolved by me", async () => {
    const doc = makeDoc({ role: "AUTHOR" });
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", docId: "d1", googleCommentId: "c1", status: "INBOX",
      resolved: false, replyCount: 0, replySlotCount: 0, driveModifiedAt: new Date("2024-06-10"),
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

  // The resolution pass is the only findMany that filters on `resolved: false`;
  // finding it by shape keeps these tests from breaking whenever another query
  // is added earlier in the sync.
  function activeSuggestionsQuery() {
    const call = mockComment.findMany.mock.calls.find(
      ([arg]) => arg?.where?.type === "SUGGESTION" && arg?.where?.resolved === false
    );
    return call?.[0];
  }

  it("does not resolve suggestions without googleSuggestionId while others are live", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    // One live suggestion — so an unmatched disco-only row might simply be that
    // suggestion under a hash we failed to match.
    mockFetchDocData.mockResolvedValue({
      suggestions: [{ id: "suggest.abc", suggestionType: SuggestionType.EDIT, insertedText: "x", deletedText: "" }],
      suggestionContent: {}, documentText: "doc",
    });
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([{ commentId: "cr1", googleSuggestionId: "suggest.abc", suggestionType: SuggestionType.EDIT, suggestionContentHash: null }])
      .mockResolvedValueOnce([]); // activeSuggestions — query filters to googleSuggestionId != null

    await syncComments(doc, driveAuth);

    // With a non-empty live set the Prisma query filters to googleSuggestionId
    // != null, so rows without one are never candidates for resolution.
    expect(activeSuggestionsQuery().where.googleSuggestionId).toEqual({ not: null });
    expect(mockComment.updateMany).not.toHaveBeenCalled();
  });

  // An empty live set is proof that nothing is open, so disco-only rows (from
  // the extension or a Gmail notification) can be closed too — otherwise an
  // accept/reject that happened with nothing watching leaves them stuck open.
  it("resolves suggestions without googleSuggestionId when the doc has none live", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: "doc" });
    mockComment.findMany
      .mockResolvedValueOnce([])  // batch fetch comments
      .mockResolvedValueOnce([])  // existingSuggestions
      .mockResolvedValueOnce([{   // activeSuggestions — disco-only row
        commentId: "cr1", googleSuggestionId: null, googleCommentId: "AAAB0xx", resolved: false, status: CommentStatus.INBOX,
      }]);

    await syncComments(doc, driveAuth);

    // No googleSuggestionId filter — every unresolved suggestion is a candidate.
    expect(activeSuggestionsQuery().where.googleSuggestionId).toBeUndefined();
    // Same treatment as an ID-tracked row: resolved, and INBOX → ARCHIVED.
    const updateManyCall = mockComment.updateMany.mock.calls[0][0];
    expect(updateManyCall.where.commentId).toEqual({ in: ["cr1"] });
    expect(updateManyCall.data.resolved).toBe(true);
    expect(updateManyCall.data.status).toBe(CommentStatus.ARCHIVED);
  });

  // Hint-driven syncs run right after the user acted in the doc, where a lagging
  // Docs read can report an empty document that isn't.
  it("does not close disco-only rows on a hint-driven sync", async () => {
    const doc = makeDoc();
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: "doc" });
    mockComment.findMany
      .mockResolvedValueOnce([])  // existingSuggestions (comments are skipped by the hint)
      .mockResolvedValueOnce([]); // activeSuggestions

    await syncComments(doc, driveAuth, undefined, undefined, { commentType: ExtCommentType.Suggestion });

    expect(activeSuggestionsQuery().where.googleSuggestionId).toEqual({ not: null });
  });

  it("honours a prefetched suggestionsUnavailable flag", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockComment.findMany.mockResolvedValueOnce([]); // batch fetch comments

    // The single-doc refresh route fetches doc data itself and passes the result
    // in. The empty list must not be treated as authoritative without the flag.
    const result = await syncComments(doc, driveAuth, undefined, {
      comments: [], suggestions: [], suggestionsUnavailable: "denied",
    });

    expect(result.suggestionsDenied).toBe(true);
    expect(mockFetchDocData).not.toHaveBeenCalled();
    expect(mockComment.updateMany).not.toHaveBeenCalled();
  });

  it("does not resolve anything when suggestions could not be read", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    // View-only access: the doc read succeeds but suggestions are withheld, so
    // the empty list says nothing about what is still open.
    mockFetchDocData.mockResolvedValue({
      suggestions: [], suggestionContent: {}, documentText: "doc", suggestionsUnavailable: "denied",
    });
    mockComment.findMany.mockResolvedValueOnce([]); // batch fetch comments

    const result = await syncComments(doc, driveAuth);

    // Phase 3 never runs: no existingSuggestions lookup, nothing resolved.
    expect(activeSuggestionsQuery()).toBeUndefined();
    expect(mockComment.updateMany).not.toHaveBeenCalled();
    // Withheld suggestions are not a failed doc — the comment sync succeeded.
    expect(result.suggestionsDenied).toBe(true);
    expect(result.permissionDenied).toBeUndefined();
  });

  it("reports a transient error when the Docs read fails", async () => {
    const doc = makeDoc();
    mockFetchCommentData.mockResolvedValue({ comments: [] });
    mockFetchDocData.mockResolvedValue({
      suggestions: [], suggestionContent: {}, documentText: null, suggestionsUnavailable: "error",
    });
    mockComment.findMany.mockResolvedValueOnce([]); // batch fetch comments

    const result = await syncComments(doc, driveAuth);

    expect(result.transientError).toBe(true);
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

// --------------- read tracking (readSlotCount) ---------------

describe("syncComments read tracking", () => {
  /** The readSlotCount written by the single update call. */
  function updatedReadCount() {
    return mockComment.update.mock.calls[0][0].data.readSlotCount;
  }
  /** Its render-space twin, written alongside it. */
  function updatedReadMessageCount() {
    return mockComment.update.mock.calls[0][0].data.readMessageCount;
  }

  it("seeds a new comment as fully read when I posted last", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ isThreadAuthor: true, replyCount: 2, replyAuthorMeFlags: [false, true] })],
    });

    await syncComments(makeDoc(), driveAuth);

    // My comment, their reply, my reply — all 3 messages read.
    expect(mockComment.createMany.mock.calls[0][0].data[0].readSlotCount).toBe(3);
  });

  it("seeds a new comment as fully unread when I never posted", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ replyCount: 2, replyAuthorMeFlags: [false, false] })],
    });

    await syncComments(makeDoc(), driveAuth);

    expect(mockComment.createMany.mock.calls[0][0].data[0].readSlotCount).toBe(0);
  });

  it("seeds partial read state through my last reply", async () => {
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({ replyCount: 3, replyAuthorMeFlags: [true, false, false] })],
    });

    await syncComments(makeDoc(), driveAuth);

    // Their comment + my reply read; the two replies after mine are not.
    expect(mockComment.createMany.mock.calls[0][0].data[0].readSlotCount).toBe(2);
  });

  it("seeds a thread that already has a tombstone with both counts, in their own spaces", async () => {
    // First sync of a thread whose middle reply was deleted before we ever saw
    // it. Slots: head, r0, [deleted], r2 — my reply is the last one.
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2, // live replies only
        replySlotCount: 3,
        replyDeleted: [false, true, false],
        replyAuthorMeFlags: [false, false, true],
      })],
    });

    await syncComments(makeDoc(), driveAuth);

    const created = mockComment.createMany.mock.calls[0][0].data[0];
    // The boundary counts all four slots; the cache counts the three messages
    // the panel will actually draw. This is the one create path where the two
    // genuinely differ.
    expect(created.readSlotCount).toBe(4);
    expect(created.readMessageCount).toBe(3);
    // Fully read: 3 of 3 drawn messages.
    expect(created.replyCount).toBe(2);
    expect(created.replySlotCount).toBe(3);
  });

  it("leaves the read count alone when someone else replies, so only new replies are unread", async () => {
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3 })]);
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
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 1, replySlotCount: 1, readSlotCount: 0 })]);
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
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 1, replySlotCount: 1, readSlotCount: 0 })]);
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
    // Someone edited a message: activity we can't localize, so the thread
    // resurfaces as unread.
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3 })]);
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

  it("holds the read boundary in place when a read reply is deleted", async () => {
    // The thread was fully read at 4 replies. Two are deleted, which leaves
    // their slots behind — so the boundary doesn't slide down over a message
    // the user never read, and a deletion on its own doesn't resurface anything.
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 4, replySlotCount: 4, readSlotCount: 5 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replySlotCount: 4,
        replyDeleted: [false, false, true, true],
        replyAuthorMeFlags: [false, false, false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    // All 3 surviving messages stay read. The old live-position boundary would
    // have slid down over slots it never covered.
    expect(updatedReadCount()).toBe(5);
    expect(updatedReadMessageCount()).toBe(3); // 3 of 3 live messages
  });

  it("clears the thread when the only unread reply is deleted", async () => {
    // head read, one unread reply from someone else, then that reply is deleted.
    // Nothing new is left to look at, so the thread goes to zero unread instead
    // of bumping the head comment back to unread.
    mockComment.findMany.mockResolvedValue([dbComment({ replyCount: 1, replySlotCount: 1, readSlotCount: 1 })]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 0,
        replySlotCount: 1,
        replyDeleted: [true],
        replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(updatedReadCount()).toBe(1);
    expect(updatedReadMessageCount()).toBe(1); // 1 of 1 live message
  });

  it("doesn't treat a slot that arrived already deleted as someone else's reply", async () => {
    // A reply posted and deleted between two syncs shows up as a brand-new
    // tombstone slot. Drive strips its author, so "not me" would otherwise read
    // as "a stranger replied" and pull my own archived thread back to Inbox for
    // a message that no longer exists.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 1, replySlotCount: 1, readSlotCount: 2, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        isThreadAuthor: true,
        replyCount: 1,
        replySlotCount: 2,
        replyDeleted: [false, true],
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    await syncComments(makeDoc({ role: "REVIEWER" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("ARCHIVED");
  });

  it("doesn't move an archived comment to Inbox for a deletion alone", async () => {
    // A deletion moves Drive's thread-level modifiedTime, which used to read as
    // "activity" and pull the doc back on an AUTHOR doc. Nothing was added, so
    // the doc would arrive in Inbox with nothing on it to explain the trip.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 1,
        replySlotCount: 2,
        replyDeleted: [false, true],
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("ARCHIVED");
    expect(res.shouldUnarchive).toBe(false);
  });

  it("doesn't move an archived comment to Inbox for a slot that arrived already deleted", async () => {
    // Same rule from the other direction: the slot count grew, but the only new
    // slot is a tombstone, so there is nothing live to show for the trip.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 1, replySlotCount: 1, readSlotCount: 2, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 1,
        replySlotCount: 2,
        replyDeleted: [false, true],
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("ARCHIVED");
    expect(res.shouldUnarchive).toBe(false);
  });

  it("still moves to Inbox when a deletion comes with a live new reply", async () => {
    // The deletion suppression must not swallow real activity landing in the
    // same window. Two replies deleted and one added, so the live count really
    // does drop — otherwise `deletedThisSync` is false and this proves nothing.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 3, replySlotCount: 3, readSlotCount: 4, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replySlotCount: 4,
        replyDeleted: [false, true, true, false],
        replyAuthorMeFlags: [false, false, false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
    expect(res.shouldUnarchive).toBe(true);
  });

  it("still acts on a resolve that lands in the same sync as a deletion", async () => {
    // A resolve flip is a state change we'd never get a second look at — the new
    // `resolved` is committed either way — so it escapes the deletion
    // suppression, and it resurfaces the last live message as unread so the doc
    // has something to show for the trip.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3, status: "INBOX", resolved: false }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 1,
        replySlotCount: 2,
        replyDeleted: [false, true],
        replyAuthorMeFlags: [false, false],
        resolved: true,
        iResolvedIt: false,
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.readSlotCount).toBe(1); // last live message unread
    expect(res.shouldUnarchive).toBe(true);
  });

  it("still acts on a re-open that lands in the same sync as a deletion", async () => {
    // The damaging direction: a thread someone re-opens must reach INBOX. If the
    // deletion swallowed it the row would still be written `resolved: false`, so
    // no later sync could ever see the transition again.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3, status: "ARCHIVED", resolved: true }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 1,
        replySlotCount: 2,
        replyDeleted: [false, true],
        replyAuthorMeFlags: [false, false],
        resolved: false,
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
    expect(mockComment.update.mock.calls[0][0].data.readSlotCount).toBe(1); // last live message unread
    expect(res.shouldUnarchive).toBe(true);
  });

  it("treats a Gmail row's over-counted replies as activity, not a deletion", async () => {
    // A Gmail-created row seeds replyCount/replySlotCount from the notification's
    // reply list, which can overshoot what Drive reports. The lower Drive count
    // is not a deletion — the slot count dropped too, and real deletions never
    // lower that — so the first Drive sync of the thread still counts as activity.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 3, replySlotCount: 3, readSlotCount: 0, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 1,
        replySlotCount: 1,
        replyAuthorMeFlags: [false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
    expect(res.shouldUnarchive).toBe(true);
  });

  it("still moves to Inbox when a message is edited", async () => {
    // An edit has no new slots and no deletion, so it stays activity — and it
    // resurfaces the last live message as unread, so the doc has something to
    // show when it arrives.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replySlotCount: 2,
        replyAuthorMeFlags: [false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const res = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
    expect(mockComment.update.mock.calls[0][0].data.readSlotCount).toBe(2); // last live message unread
    expect(res.shouldUnarchive).toBe(true);
  });

  it("sees a reply that arrives in the same window as a deletion", async () => {
    // The live reply count is unchanged — one deleted, one added — so the old
    // `replyCount` comparison found no new replies and the thread never
    // resurfaced. Slot counts only grow, so this can't hide.
    mockComment.findMany.mockResolvedValue([
      dbComment({ replyCount: 2, replySlotCount: 2, readSlotCount: 3, status: "ARCHIVED" }),
    ]);
    mockFetchCommentData.mockResolvedValue({
      comments: [driveComment({
        replyCount: 2,
        replySlotCount: 3,
        replyDeleted: [true, false, false],
        replyAuthorMeFlags: [false, false, false],
        driveModifiedAt: new Date("2024-06-20"),
      })],
    });

    const { shouldUnarchive } = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth);

    expect(mockComment.update.mock.calls[0][0].data.status).toBe("INBOX");
    expect(shouldUnarchive).toBe(true);
    // The boundary is carried forward, so exactly the new reply reads as unread.
    expect(updatedReadCount()).toBe(3);
    expect(updatedReadMessageCount()).toBe(2); // 2 of 3 live messages
  });
});

// --------------- revoked comment access (Drive 403) ---------------

describe("syncSingleComment permission denied", () => {
  function denied(code: number) {
    return Object.assign(new Error(`code ${code}`), { code });
  }

  it("reports permissionDenied and leaves the DB record untouched on 403", async () => {
    vi.mocked(fetchThreadDetail).mockRejectedValue(denied(403));
    const existing = dbComment();
    mockComment.findFirst.mockResolvedValue(existing);

    const result = await syncSingleComment(makeDoc({ role: "AUTHOR" }), "c1", driveAuth);

    expect(result.permissionDenied).toBe(true);
    expect(result.deleted).toBe(false);
    expect(result.comment).toBe(existing);
    // A 403 says nothing about whether the comment still exists — unlike a 404,
    // it must not delete the row.
    expect(mockComment.delete).not.toHaveBeenCalled();
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("still deletes the record on 404, which does mean the comment is gone", async () => {
    vi.mocked(fetchThreadDetail).mockRejectedValue(denied(404));
    mockComment.findFirst.mockResolvedValue(dbComment());

    const result = await syncSingleComment(makeDoc({ role: "AUTHOR" }), "c1", driveAuth);

    expect(result.permissionDenied).toBeUndefined();
    expect(result.deleted).toBe(true);
    expect(mockComment.delete).toHaveBeenCalled();
  });
});

// A hint-driven sync that hits a 403 must still run the full sync, which is what
// stamps sync time and reports permissionDenied to the caller.
describe("syncComments single-comment hint on denied access", () => {
  it("falls through to the full sync", async () => {
    vi.mocked(fetchThreadDetail).mockRejectedValue(Object.assign(new Error("code 403"), { code: 403 }));
    mockComment.findFirst.mockResolvedValue(dbComment());
    vi.mocked(fetchCommentData).mockRejectedValue(Object.assign(new Error("code 403"), { code: 403 }));

    const result = await syncComments(makeDoc({ role: "AUTHOR" }), driveAuth, undefined, undefined, {
      commentType: "comment",
      googleCommentId: "c1",
    });

    expect(fetchCommentData).toHaveBeenCalled();
    expect(result.permissionDenied).toBe(true);
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
    expect(data.readSlotCount).toBe(1); // still fully read (1 of 1 messages)
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
    expect(data.readSlotCount).toBe(1);
    expect(data.replyCount).toBe(1);
  });
});

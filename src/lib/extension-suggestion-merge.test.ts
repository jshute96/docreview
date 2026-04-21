import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommentStatus, CommentType, DocRole, SuggestionType, type Doc } from "@prisma/client";

// ---------- Mocks ----------

vi.mock("@/lib/prisma", () => {
  const comment = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const $executeRaw = vi.fn();
  return {
    prisma: {
      comment,
      $executeRaw,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ comment, $executeRaw })),
    },
  };
});

vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

// Use the real computeMentionedMeUnreplied from google-drive — it's a pure
// utility with no side effects at import time. Mocking it previously drifted
// out of sync with the real implementation.
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return { computeMentionedMeUnreplied: actual.computeMentionedMeUnreplied };
});

// Parse relative timestamps to deterministic Date values.
vi.mock("@/lib/extension-suggestions", () => ({
  parseExtensionTimestamp: (s: string) => (s ? new Date(`2026-03-20T15:00:00.000Z`) : null),
}));

import { mergeExtensionSuggestions, type ExtensionSuggestionInput } from "./extension-suggestion-merge";
import { prisma } from "@/lib/prisma";
import { computeSuggestionHash } from "@/lib/suggestion-hash";

const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;

// ---------- Helpers ----------

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    docId: "d1",
    userId: "u1",
    googleDocId: "gdoc1",
    title: "Test Doc",
    driveUrl: "https://docs.google.com/document/d/gdoc1/edit",
    mimeType: "application/vnd.google-apps.document",
    role: DocRole.REVIEWER,
    ...overrides,
  } as Doc;
}

function makeSuggestion(overrides: Partial<ExtensionSuggestionInput> = {}): ExtensionSuggestionInput {
  return {
    id: "AAAB1disco",
    suggestionType: "Add",
    status: "open",
    oldText: "",
    newText: "new text",
    description: "",
    author: "Alice",
    isMine: false,
    timestamp: "3:00 PM Mar 20",
    replies: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockComment.findFirst.mockResolvedValue(null);
  mockComment.findMany.mockResolvedValue([]);
  mockComment.create.mockResolvedValue({});
  mockComment.update.mockResolvedValue({});
  mockComment.delete.mockResolvedValue({});
});

// ---------- Tests ----------

describe("mergeExtensionSuggestions", () => {
  const userEmail = "me@example.com";

  it("returns empty counts with no suggestions", async () => {
    const res = await mergeExtensionSuggestions("d1", "gdoc1", [], userEmail, makeDoc());
    expect(res).toEqual({
      merged: 0, inserted: 0, updated: 0, resolved: 0,
      shouldUnarchive: false, comments: [],
    });
  });

  it("inserts a new row when no match by disco ID or content hash", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());

    expect(mockComment.create).toHaveBeenCalledTimes(1);
    const data = mockComment.create.mock.calls[0][0].data;
    expect(data.googleCommentId).toBe("AAAB1disco");
    expect(data.type).toBe(CommentType.SUGGESTION);
    expect(data.suggestionType).toBe(SuggestionType.INSERT);
    expect(data.status).toBe(CommentStatus.ARCHIVED); // reviewer doc, not mine, not resolved, no mentions → ARCHIVED
  });

  it("sets initial status=INBOX on reviewer doc when thread has a reply from me (isReplyAuthor)", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      replies: [{ author: "Me", isMine: true, timestamp: "3:01 PM Mar 20", text: "sgtm" }],
    })], userEmail, makeDoc());
    expect(mockComment.create.mock.calls[0][0].data.status).toBe(CommentStatus.INBOX);
  });

  it("sets initial status=INBOX on author doc", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc({ role: DocRole.AUTHOR }));
    expect(mockComment.create.mock.calls[0][0].data.status).toBe(CommentStatus.INBOX);
  });

  it("flags shouldUnarchive when a new row lands in INBOX", async () => {
    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc({ role: DocRole.AUTHOR }));
    expect(res.shouldUnarchive).toBe(true);
    expect(res.inserted).toBe(1);
  });

  it("treats originalContentDeleted as resolved → ARCHIVED for new rows", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      originalContentDeleted: true,
    })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
    expect(mockComment.create.mock.calls[0][0].data.status).toBe(CommentStatus.ARCHIVED);
  });

  it("updates metadata in place when disco ID already exists", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      status: "accepted",
      replies: [{ author: "A", isMine: false, timestamp: "4:00 PM Mar 20", text: "", action: "accept" }],
    })], userEmail, makeDoc());

    expect(mockComment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { commentId: "cr1" },
    }));
    expect(res.updated).toBe(1);
    expect(res.resolved).toBe(1); // flipped resolved 0→1
    expect(mockComment.create).not.toHaveBeenCalled();
  });

  // --- Partner-merge (disco-only existing row + suggestion-only partner) ---

  it("merges a disco-only existing row with a unique suggestion-only partner by hash", async () => {
    const hash = computeSuggestionHash(SuggestionType.INSERT, "", "new text");
    // Found by disco ID but missing googleSuggestionId
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow",
      googleCommentId: "AAAB1disco",
      googleSuggestionId: null,
      suggestionContentHash: hash,
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });
    // One suggestion-only partner with same hash
    mockComment.findMany.mockResolvedValue([{
      commentId: "sugRow",
      googleCommentId: null,
      googleSuggestionId: "suggest.xyz",
      suggestionContentHash: hash,
      status: CommentStatus.ARCHIVED,
      replyCount: 0,
      resolved: false,
    }]);

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());

    // Partner deleted
    expect(mockComment.delete).toHaveBeenCalledWith({ where: { commentId: "sugRow" } });
    // googleSuggestionId salvaged onto the existing disco row
    const updateArgs = mockComment.update.mock.calls.map((c) => c[0]);
    const salvage = updateArgs.find((a) => a.data?.googleSuggestionId === "suggest.xyz");
    expect(salvage).toBeDefined();
    expect(salvage.where).toEqual({ commentId: "discoRow" });
  });

  it("does NOT partner-merge when the only hash candidate also lacks a googleSuggestionId", async () => {
    const hash = computeSuggestionHash(SuggestionType.INSERT, "", "new text");
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow",
      googleCommentId: "AAAB1disco",
      googleSuggestionId: null,
      suggestionContentHash: hash,
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });
    // Candidate has no googleSuggestionId to salvage — defensive filter rejects
    mockComment.findMany.mockResolvedValue([{
      commentId: "other",
      googleCommentId: null,
      googleSuggestionId: null,
      suggestionContentHash: hash,
      status: CommentStatus.ARCHIVED,
      replyCount: 0,
      resolved: false,
    }]);

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());

    expect(mockComment.delete).not.toHaveBeenCalled();
    // No update call assigns a googleSuggestionId
    const assignedSuggestionId = mockComment.update.mock.calls.find((c) => c[0]?.data?.googleSuggestionId);
    expect(assignedSuggestionId).toBeUndefined();
  });

  it("does NOT partner-merge when multiple qualifying partners match the hash", async () => {
    const hash = computeSuggestionHash(SuggestionType.INSERT, "", "new text");
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow",
      googleCommentId: "AAAB1disco",
      googleSuggestionId: null,
      suggestionContentHash: hash,
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });
    mockComment.findMany.mockResolvedValue([
      { commentId: "a", googleCommentId: null, googleSuggestionId: "suggest.a",
        suggestionContentHash: hash, status: CommentStatus.ARCHIVED, replyCount: 0, resolved: false },
      { commentId: "b", googleCommentId: null, googleSuggestionId: "suggest.b",
        suggestionContentHash: hash, status: CommentStatus.ARCHIVED, replyCount: 0, resolved: false },
    ]);

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());

    expect(mockComment.delete).not.toHaveBeenCalled();
    const assignedSuggestionId = mockComment.update.mock.calls.find((c) => c[0]?.data?.googleSuggestionId);
    expect(assignedSuggestionId).toBeUndefined();
  });

  it("merges by content hash when exactly one candidate matches", async () => {
    const hash = computeSuggestionHash(SuggestionType.INSERT, "", "new text");
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([{
      commentId: "cr1",
      googleCommentId: null,
      suggestionContentHash: hash,
      status: CommentStatus.ARCHIVED,
      replyCount: 0,
      resolved: false,
    }]);

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc({ role: DocRole.AUTHOR }));
    expect(res.merged).toBe(1);
    expect(res.inserted).toBe(0);
    expect(mockComment.update).toHaveBeenCalled();
    const args = mockComment.update.mock.calls[0][0];
    expect(args.where).toEqual({ commentId: "cr1" });
    expect(args.data.googleCommentId).toBe("AAAB1disco");
    // Re-evaluated: ARCHIVED on author doc with no participation → unchanged via computeSuggestionStatusUpdate
    // (no new replies), but fall-through re-check promotes to INBOX because isDocAuthor.
    expect(args.data.status).toBe(CommentStatus.INBOX);
    expect(res.shouldUnarchive).toBe(true);
  });

  it("inserts a new row when multiple candidates match by hash (ambiguous)", async () => {
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([
      { commentId: "cr1", googleCommentId: null, replyCount: 0, resolved: false, status: CommentStatus.ARCHIVED },
      { commentId: "cr2", googleCommentId: null, replyCount: 0, resolved: false, status: CommentStatus.ARCHIVED },
    ]);

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());
    expect(res.inserted).toBe(1);
    expect(res.merged).toBe(0);
    expect(mockComment.create).toHaveBeenCalled();
  });

  it("preserves MUTED status across metadata updates", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.MUTED,
      replyCount: 0,
      resolved: false,
    });

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      status: "accepted",
      replies: [{ author: "A", isMine: false, timestamp: "4:00 PM Mar 20", text: "", action: "accept" }],
    })], userEmail, makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    // status should not be changed on MUTED (unless new reply mentions me — which it doesn't here)
    expect(args.data.status).toBeUndefined();
  });

  it("breaks MUTED out to INBOX when a new reply mentions me", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.MUTED,
      replyCount: 0,
      resolved: false,
    });

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      replies: [{
        author: "Alice", isMine: false, timestamp: "4:00 PM Mar 20",
        text: "hey", html: '<a href="mailto:me@example.com">me</a>',
      }],
    })], userEmail, makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    expect(args.data.status).toBe(CommentStatus.INBOX);
  });

  it("archives my own accepted suggestion with no discussion replies", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      isMine: true,
      status: "accepted",
      replies: [{ author: "Other", isMine: false, timestamp: "4:00 PM Mar 20", text: "", action: "accept" }],
    })], userEmail, makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    expect(args.data.status).toBe(CommentStatus.ARCHIVED);
  });

  it("archives someone else's suggestion when I accept/reject it", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      isMine: false,
      status: "rejected",
      replies: [{ author: "Me", isMine: true, timestamp: "4:00 PM Mar 20", text: "", action: "reject" }],
    })], userEmail, makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    expect(args.data.status).toBe(CommentStatus.ARCHIVED);
  });

  it("sends existing suggestion to INBOX when a new reply mentions me", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.ARCHIVED,
      replyCount: 1,
      resolved: false,
    });

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      replies: [
        { author: "Alice", isMine: false, timestamp: "3:01 PM", text: "first" },
        { author: "Bob", isMine: false, timestamp: "4:00 PM",
          text: "ping", html: '<a href="mailto:me@example.com">me</a>' },
      ],
    })], userEmail, makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    expect(args.data.status).toBe(CommentStatus.INBOX);
    expect(res.shouldUnarchive).toBe(true);
  });

  it("tracks resolved count transitions (0→1)", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.INBOX,
      replyCount: 0,
      resolved: false,
    });

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      status: "rejected",
      replies: [{ author: "A", isMine: false, timestamp: "4:00 PM", text: "", action: "reject" }],
    })], userEmail, makeDoc());
    expect(res.resolved).toBe(1);
  });

  it("does not double-count resolved when it was already resolved", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.ARCHIVED,
      replyCount: 0,
      resolved: true,
    });

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      status: "accepted",
      replies: [],
    })], userEmail, makeDoc());
    expect(res.resolved).toBe(0);
  });

  it("maps Replace type to EDIT with both old+new text in hash", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      suggestionType: "Replace",
      oldText: "before",
      newText: "after",
    })], userEmail, makeDoc());

    const data = mockComment.create.mock.calls[0][0].data;
    expect(data.suggestionType).toBe(SuggestionType.EDIT);
    expect(data.suggestionContentHash).toBe(computeSuggestionHash(SuggestionType.EDIT, "before", "after"));
  });

  it("maps Delete type with only oldText", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      suggestionType: "Delete",
      oldText: "removed",
      newText: "",
    })], userEmail, makeDoc());

    const data = mockComment.create.mock.calls[0][0].data;
    expect(data.suggestionType).toBe(SuggestionType.DELETE);
    expect(data.suggestionContentHash).toBe(computeSuggestionHash(SuggestionType.DELETE, "removed", ""));
  });

  it("returns final suggestion comments sorted in fetch", async () => {
    mockComment.findMany
      .mockResolvedValueOnce([]) // candidate lookup (hash)
      .mockResolvedValueOnce([{ commentId: "cr1" }]); // final state

    const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());
    expect(res.comments).toEqual([{ commentId: "cr1" }]);

    // verify findMany called with orderBy for final state
    const finalCall = mockComment.findMany.mock.calls[mockComment.findMany.mock.calls.length - 1][0];
    expect(finalCall.orderBy).toBeDefined();
    expect(finalCall.where).toEqual({ docId: "d1", type: CommentType.SUGGESTION });
  });

  it("maps unknown suggestion types (e.g. Format) to OTHER with empty-text hash", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      suggestionType: "Format",
      oldText: "",
      newText: "",
      description: "Format: Bold",
    })], userEmail, makeDoc());

    const data = mockComment.create.mock.calls[0][0].data;
    expect(data.suggestionType).toBe(SuggestionType.OTHER);
    expect(data.suggestionContentHash).toBe(computeSuggestionHash(SuggestionType.OTHER, "", ""));
  });

  it("treats originalContentDeleted as resolved when inserting a new row", async () => {
    // Author doc — absent originalContentDeleted this would land in INBOX.
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      originalContentDeleted: true,
    })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
    expect(mockComment.create.mock.calls[0][0].data.status).toBe(CommentStatus.ARCHIVED);
  });

  it("detects mentions case-insensitively (mixed-case email in reply HTML)", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1",
      status: CommentStatus.MUTED,
      replyCount: 0,
      resolved: false,
    });

    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
      replies: [{
        author: "Alice", isMine: false, timestamp: "4:00 PM Mar 20",
        text: "hey", html: '<a href="mailto:Me@Example.COM">Me</a>',
      }],
    })], "me@example.com", makeDoc());

    const args = mockComment.update.mock.calls[0][0];
    expect(args.data.status).toBe(CommentStatus.INBOX);
  });

  it("bumps lastCommentActivity when inserting a new suggestion", async () => {
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());
    // bumpLastCommentActivity uses $executeRaw — one call per suggestion write
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("bumps lastCommentActivity when merging by content hash", async () => {
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValueOnce([{
      commentId: "cr1", googleCommentId: null,
      status: CommentStatus.ARCHIVED, replyCount: 0, resolved: false,
    }]);
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("bumps lastCommentActivity when updating an existing disco ID", async () => {
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false,
    });
    await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion()], userEmail, makeDoc());
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  // ---------- isRead computation ----------

  describe("isRead", () => {
    it("marks new suggestion as read when it's my own with no replies", async () => {
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({ isMine: true })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(mockComment.create.mock.calls[0][0].data.isRead).toBe(true);
    });

    it("marks new suggestion as unread when it's someone else's with no replies", async () => {
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({ isMine: false })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(mockComment.create.mock.calls[0][0].data.isRead).toBe(false);
    });

    it("marks new suggestion as read when my reply is the last one", async () => {
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: false,
        replies: [
          { author: "Alice", isMine: false, timestamp: "3:01 PM Mar 20", text: "first" },
          { author: "Me", isMine: true, timestamp: "4:00 PM Mar 20", text: "reply" },
        ],
      })], userEmail, makeDoc());
      expect(mockComment.create.mock.calls[0][0].data.isRead).toBe(true);
    });

    it("marks new suggestion as unread when someone else's reply is the last one", async () => {
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true,
        replies: [
          { author: "Me", isMine: true, timestamp: "3:01 PM Mar 20", text: "first" },
          { author: "Alice", isMine: false, timestamp: "4:00 PM Mar 20", text: "reply" },
        ],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(mockComment.create.mock.calls[0][0].data.isRead).toBe(false);
    });

    it("marks new suggestion as read when I accepted my own suggestion (last action is mine)", async () => {
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true,
        status: "accepted",
        replies: [{ author: "Me", isMine: true, timestamp: "4:00 PM Mar 20", text: "", action: "accept" }],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(mockComment.create.mock.calls[0][0].data.isRead).toBe(true);
    });

    it("marks existing suggestion read when a new reply from me arrives", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: false,
      });
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        replies: [{ author: "Me", isMine: true, timestamp: "4:00 PM Mar 20", text: "reply" }],
      })], userEmail, makeDoc());
      expect(mockComment.update.mock.calls[0][0].data.isRead).toBe(true);
    });

    it("marks existing suggestion unread when a new reply from someone else arrives", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: true,
      });
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        replies: [{ author: "Alice", isMine: false, timestamp: "4:00 PM Mar 20", text: "reply" }],
      })], userEmail, makeDoc());
      expect(mockComment.update.mock.calls[0][0].data.isRead).toBe(false);
    });

    it("preserves manually-toggled isRead when no new activity", async () => {
      // User manually marked as read, no new replies or state change → keep isRead=true
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: true,
      });
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({ isMine: false })], userEmail, makeDoc());
      expect(mockComment.update.mock.calls[0][0].data.isRead).toBe(true);
    });

    it("flips isRead when resolve state changes (my suggestion accepted by someone else)", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: true,
      });
      // Reply arrives: my suggestion, they accepted it (the accept reply is theirs)
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true, status: "accepted",
        replies: [{ author: "Alice", isMine: false, timestamp: "4:00 PM Mar 20", text: "", action: "accept" }],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(mockComment.update.mock.calls[0][0].data.isRead).toBe(false);
    });

    it("sets isRead on hash-match merge into a Drive-first row", async () => {
      mockComment.findFirst.mockResolvedValue(null);
      mockComment.findMany.mockResolvedValueOnce([{
        commentId: "cr1", googleCommentId: null, suggestionContentHash: computeSuggestionHash(SuggestionType.INSERT, "", "new text"),
        status: CommentStatus.ARCHIVED, replyCount: 0, resolved: false, isRead: false,
      }]);
      await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true,
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      // New row was my own with no replies → isRead=true
      expect(mockComment.update.mock.calls[0][0].data.isRead).toBe(true);
    });
  });

  // ---------- shouldUnarchive gating on isRead ----------

  describe("shouldUnarchive gating", () => {
    it("does NOT unarchive when I inserted my own suggestion (isRead=true)", async () => {
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({ isMine: true })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(res.inserted).toBe(1);
      expect(res.shouldUnarchive).toBe(false);
    });

    it("does NOT unarchive on hash-match merge when I just made the suggestion", async () => {
      mockComment.findFirst.mockResolvedValue(null);
      mockComment.findMany.mockResolvedValueOnce([{
        commentId: "cr1", googleCommentId: null, suggestionContentHash: computeSuggestionHash(SuggestionType.INSERT, "", "new text"),
        status: CommentStatus.ARCHIVED, replyCount: 0, resolved: false, isRead: false,
      }]);
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({ isMine: true })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(res.shouldUnarchive).toBe(false);
    });

    it("unarchives when existing INBOX suggestion gets new reply from someone else (rule 2)", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 1, resolved: false, isRead: true,
      });
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true,
        replies: [
          { author: "Me", isMine: true, timestamp: "3:01 PM", text: "first" },
          { author: "Alice", isMine: false, timestamp: "4:00 PM", text: "reply" },
        ],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(res.shouldUnarchive).toBe(true);
    });

    it("does NOT unarchive when existing INBOX suggestion gets new reply but I was the one who accepted (rule 2 exception)", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: false,
      });
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: false, status: "accepted",
        replies: [{ author: "Me", isMine: true, timestamp: "4:00 PM", text: "", action: "accept" }],
      })], userEmail, makeDoc());
      // I accepted someone else's suggestion — doc shouldn't resurface
      expect(res.shouldUnarchive).toBe(false);
    });

    it("unarchives when my INBOX suggestion is accepted by someone else (rule 3)", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: true,
      });
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true, status: "accepted",
        // Enough replies that the silent-accept archive rule doesn't fire
        replies: [
          { author: "Alice", isMine: false, timestamp: "3:00 PM", text: "looks good" },
          { author: "Alice", isMine: false, timestamp: "4:00 PM", text: "", action: "accept" },
        ],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(res.shouldUnarchive).toBe(true);
    });

    it("does NOT unarchive when my INBOX suggestion is silently accepted by someone else (archive transition)", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 0, resolved: false, isRead: true,
      });
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        isMine: true, status: "accepted",
        // Only the accept action, no discussion → silent accept → target=ARCHIVED
        replies: [{ author: "Alice", isMine: false, timestamp: "4:00 PM", text: "", action: "accept" }],
      })], userEmail, makeDoc({ role: DocRole.AUTHOR }));
      expect(res.shouldUnarchive).toBe(false);
    });

    it("does NOT unarchive when existing INBOX suggestion has no new activity and isRead is preserved", async () => {
      mockComment.findFirst.mockResolvedValue({
        commentId: "cr1", status: CommentStatus.INBOX, replyCount: 2, resolved: false, isRead: true,
      });
      const res = await mergeExtensionSuggestions("d1", "gdoc1", [makeSuggestion({
        replies: [
          { author: "Alice", isMine: false, timestamp: "3:00 PM", text: "first" },
          { author: "Me", isMine: true, timestamp: "3:30 PM", text: "reply" },
        ],
      })], userEmail, makeDoc());
      expect(res.shouldUnarchive).toBe(false);
    });
  });
});

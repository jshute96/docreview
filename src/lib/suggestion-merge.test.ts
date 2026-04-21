import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const comment = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return {
    prisma: {
      comment,
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ comment, $executeRaw: vi.fn() })),
    },
  };
});
vi.mock("@/lib/parse-gmail-notification", async () => {
  const actual = await vi.importActual("@/lib/parse-gmail-notification");
  return {
    ...actual,
    parseGmailNotificationFromParsed: vi.fn(),
  };
});

import { mergeSuggestionsFromGmail } from "./suggestion-merge";
import { prisma } from "@/lib/prisma";
import { parseGmailNotificationFromParsed } from "@/lib/parse-gmail-notification";
import { computeSuggestionHash } from "./suggestion-hash";

const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockParse = vi.mocked(parseGmailNotificationFromParsed);

const email = { headers: new Map(), textBody: "", htmlBody: "<html></html>" };

function makeSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    author: "Alice",
    time_str: "3:00 PM",
    time: "2026-03-20T15:00:00Z",
    action: "Add",
    text: "new text",
    isNew: true,
    discussionId: "AAAB0abc",
    openUrl: "https://docs.google.com/...",
    replyTo: "reply@docs.google.com",
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

describe("mergeSuggestionsFromGmail", () => {
  it("returns zeros when parse fails", async () => {
    mockParse.mockImplementation(() => { throw new Error("parse error"); });
    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0, shouldUnarchive: false });
  });

  it("returns zeros when no suggestions in notification", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [], suggestions: [],
    });
    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0, shouldUnarchive: false });
  });

  it("merges into existing Drive-created row by content hash", async () => {
    const hash = computeSuggestionHash("INSERT", "", "new text");
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    // No existing row with this googleCommentId
    mockComment.findFirst.mockResolvedValue(null);
    // One match by content hash (Drive-created row without googleCommentId)
    mockComment.findMany.mockResolvedValue([{
      commentId: "cr1", googleCommentId: null, replyCount: 0,
    }]);

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 1, inserted: 0, shouldUnarchive: false });
    expect(mockComment.update).toHaveBeenCalledWith({
      where: { commentId: "cr1" },
      data: { googleCommentId: "AAAB0abc", replyCount: 0, driveCreatedAt: new Date("2026-03-20T15:00:00Z") },
    });
  });

  it("inserts new row when no hash match (Gmail arrives first)", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([]); // no hash match

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 1, shouldUnarchive: true });

    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.googleCommentId).toBe("AAAB0abc");
    expect(createCall.data.type).toBe("SUGGESTION");
    expect(createCall.data.suggestionType).toBe("INSERT");
    expect(createCall.data.status).toBe("INBOX");
    expect(createCall.data.driveCreatedAt).toEqual(new Date("2026-03-20T15:00:00Z"));
  });

  it("skips when googleCommentId already exists in DB (idempotent)", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    // Already merged — row with this googleCommentId exists
    const hash = computeSuggestionHash("INSERT", "", "new text");
    mockComment.findFirst.mockResolvedValue({ commentId: "cr1", suggestionContentHash: hash });

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0, shouldUnarchive: false });
    expect(mockComment.update).not.toHaveBeenCalled();
    expect(mockComment.create).not.toHaveBeenCalled();
  });

  it("skips when multiple hash matches (ambiguous)", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    mockComment.findFirst.mockResolvedValue(null);
    // Two rows with same hash — ambiguous
    mockComment.findMany.mockResolvedValue([
      { commentId: "cr1", googleCommentId: null, replyCount: 0 },
      { commentId: "cr2", googleCommentId: null, replyCount: 0 },
    ]);

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0, shouldUnarchive: false });
  });

  it("merges replyCount from Gmail replies", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion({
        replies: [
          { author: "Bob", time_str: "4:00 PM", text: "looks good", isNew: false },
          { author: "Carol", time_str: "5:00 PM", text: "agreed", isNew: false },
        ],
      })],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([{
      commentId: "cr1", googleCommentId: null, replyCount: 0,
    }]);

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.replyCount).toBe(2);
  });

  it("handles Replace action correctly", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion({
        action: "Replace",
        text: "old → new",
        oldText: "old",
        newText: "new",
      })],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([]); // Gmail first

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.suggestionType).toBe("EDIT");
    // Verify hash matches what Drive would compute
    const expectedHash = computeSuggestionHash("EDIT", "old", "new");
    expect(createCall.data.suggestionContentHash).toBe(expectedHash);
  });

  it("promotes ARCHIVED suggestion to INBOX on merge", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([{
      commentId: "cr1", googleCommentId: null, replyCount: 0, status: "ARCHIVED",
    }]);

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 1, inserted: 0, shouldUnarchive: true });
    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("INBOX");
  });

  it("does not promote MUTED suggestion on merge", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([{
      commentId: "cr1", googleCommentId: null, replyCount: 0, status: "MUTED",
    }]);

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 1, inserted: 0, shouldUnarchive: false });
    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBeUndefined();
  });

  // --- Partner merge + hash-fill rules ---

  it("merges a disco-only existing row with a unique suggestion-only partner by hash", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    const hash = computeSuggestionHash("INSERT", "", "new text");
    // Found by disco ID but missing googleSuggestionId
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow", googleCommentId: "AAAB0abc", googleSuggestionId: null,
      suggestionContentHash: hash,
    });
    // One suggestion-only partner with same hash
    mockComment.findMany.mockResolvedValue([
      { commentId: "sugRow", googleCommentId: null, googleSuggestionId: "suggest.xyz",
        suggestionContentHash: hash, replyCount: 0 },
    ]);

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);

    // Partner deleted, existing updated with salvaged googleSuggestionId
    expect(mockComment.update).toHaveBeenCalledWith({
      where: { commentId: "discoRow" },
      data: { googleSuggestionId: "suggest.xyz" },
    });
  });

  it("does not merge when the only hash candidate is itself missing googleSuggestionId", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    const hash = computeSuggestionHash("INSERT", "", "new text");
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow", googleCommentId: "AAAB0abc", googleSuggestionId: null,
      suggestionContentHash: hash,
    });
    // Candidate has no googleSuggestionId to salvage — should be filtered out
    mockComment.findMany.mockResolvedValue([
      { commentId: "other", googleCommentId: null, googleSuggestionId: null,
        suggestionContentHash: hash, replyCount: 0 },
    ]);

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);

    // No update call for the partner-merge step
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("does not merge when multiple qualifying partners match the hash", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    const hash = computeSuggestionHash("INSERT", "", "new text");
    mockComment.findFirst.mockResolvedValue({
      commentId: "discoRow", googleCommentId: "AAAB0abc", googleSuggestionId: null,
      suggestionContentHash: hash,
    });
    mockComment.findMany.mockResolvedValue([
      { commentId: "a", googleCommentId: null, googleSuggestionId: "suggest.a",
        suggestionContentHash: hash, replyCount: 0 },
      { commentId: "b", googleCommentId: null, googleSuggestionId: "suggest.b",
        suggestionContentHash: hash, replyCount: 0 },
    ]);

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("fills suggestionContentHash when missing on the existing disco-ID row", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    // Existing row found by disco ID, already has googleSuggestionId (so partner
    // branch is skipped), but no hash yet.
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1", googleCommentId: "AAAB0abc", googleSuggestionId: "suggest.xyz",
      suggestionContentHash: null,
    });

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);

    const expectedHash = computeSuggestionHash("INSERT", "", "new text");
    expect(mockComment.update).toHaveBeenCalledWith({
      where: { commentId: "cr1" },
      data: { suggestionContentHash: expectedHash },
    });
  });

  it("does NOT overwrite an existing suggestionContentHash (Gmail is fill-only)", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion()],
    });
    // Existing row already has a stale/different hash from Drive or extension.
    // Gmail should not touch it.
    mockComment.findFirst.mockResolvedValue({
      commentId: "cr1", googleCommentId: "AAAB0abc", googleSuggestionId: "suggest.xyz",
      suggestionContentHash: "deadbeef-hash-from-fresh-source",
    });

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);

    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("handles Delete action correctly", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [],
      suggestions: [makeSuggestion({
        action: "Delete",
        text: "removed text",
      })],
    });
    mockComment.findFirst.mockResolvedValue(null);
    mockComment.findMany.mockResolvedValue([]);

    await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.suggestionType).toBe("DELETE");
    const expectedHash = computeSuggestionHash("DELETE", "removed text", "");
    expect(createCall.data.suggestionContentHash).toBe(expectedHash);
  });
});

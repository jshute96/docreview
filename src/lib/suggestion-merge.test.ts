import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    comment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));
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
});

describe("mergeSuggestionsFromGmail", () => {
  it("returns zeros when parse fails", async () => {
    mockParse.mockImplementation(() => { throw new Error("parse error"); });
    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0 });
  });

  it("returns zeros when no suggestions in notification", async () => {
    mockParse.mockReturnValue({
      type: "comment",
      subject: "", from: "", to: "", date_str: "",
      documentId: "gdoc1", documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      comments: [], suggestions: [],
    });
    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0 });
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
    expect(result).toEqual({ merged: 1, inserted: 0 });
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
    expect(result).toEqual({ merged: 0, inserted: 1 });

    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.googleCommentId).toBe("AAAB0abc");
    expect(createCall.data.type).toBe("SUGGESTION");
    expect(createCall.data.suggestionType).toBe("INSERT");
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
    mockComment.findFirst.mockResolvedValue({ commentId: "cr1" });

    const result = await mergeSuggestionsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ merged: 0, inserted: 0 });
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
    expect(result).toEqual({ merged: 0, inserted: 0 });
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
    expect(result).toEqual({ merged: 1, inserted: 0 });
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
    expect(result).toEqual({ merged: 1, inserted: 0 });
    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBeUndefined();
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

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const comment = {
    findFirst: vi.fn(),
    create: vi.fn(),
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

import { mergeCommentsFromGmail } from "./comment-merge";
import { prisma } from "@/lib/prisma";
import { parseGmailNotificationFromParsed } from "@/lib/parse-gmail-notification";

const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
const mockParse = vi.mocked(parseGmailNotificationFromParsed);

const email = { headers: new Map(), textBody: "", htmlBody: "<html></html>" };

function makeCommentThread(overrides: Record<string, unknown> = {}) {
  return {
    quotedText: "some doc text",
    discussionId: "AAAB1xyz",
    openUrl: "https://docs.google.com/...",
    replyTo: "reply@docs.google.com",
    replies: [
      { author: "Alice", time_str: "3:00 PM, Mar 20 (UTC)", time: "2026-03-20T15:00:00.000Z", text: "+someone@example.com check this", isNew: true },
    ],
    ...overrides,
  };
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    type: "comment" as const,
    subject: "Test",
    from: "comments-noreply@docs.google.com",
    to: "someone@example.com",
    date_str: "Fri, 20 Mar 2026 15:00:00 +0000",
    date: "2026-03-20T15:00:00.000Z",
    documentId: "gdoc1",
    documentTitle: "Test Doc",
    documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
    noCommentsPermission: true,
    comments: [makeCommentThread()],
    suggestions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockComment.findFirst.mockResolvedValue(null);
  mockComment.create.mockResolvedValue({});
});

describe("mergeCommentsFromGmail", () => {
  it("returns zeros when parse fails", async () => {
    mockParse.mockImplementation(() => { throw new Error("parse error"); });
    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
  });

  it("returns zeros when notification is not a comment type", async () => {
    mockParse.mockReturnValue({
      type: "sharing",
      subject: "", from: "", to: "", date_str: "",
      sharerName: "Alice", sharerEmail: "alice@example.com",
      permission: "edit", isRequest: false,
      documentTitle: "Test", documentUrl: "https://docs.google.com/document/d/gdoc1/edit",
      documentId: "gdoc1",
    });
    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
  });

  it("returns zeros when noCommentsPermission is false", async () => {
    mockParse.mockReturnValue(makeNotification({ noCommentsPermission: undefined }));
    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
  });

  it("returns zeros when no comments in notification", async () => {
    mockParse.mockReturnValue(makeNotification({ comments: [] }));
    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
  });

  it("inserts new comment from Gmail notification", async () => {
    mockParse.mockReturnValue(makeNotification());
    mockComment.findFirst.mockResolvedValue(null);

    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 1, shouldUnarchive: true });

    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.googleCommentId).toBe("AAAB1xyz");
    expect(createCall.data.type).toBe("COMMENT");
    expect(createCall.data.status).toBe("INBOX");
    expect(createCall.data.mentionedMe).toBe(true);
    expect(createCall.data.mentionedMeUnreplied).toBe(true);
    expect(createCall.data.assignedToMe).toBe(false);
    expect(createCall.data.isThreadAuthor).toBe(false);
    expect(createCall.data.isReplyAuthor).toBe(false);
    expect(createCall.data.driveCreatedAt).toEqual(new Date("2026-03-20T15:00:00.000Z"));
    expect(createCall.data.driveModifiedAt).toEqual(new Date("2026-03-20T15:00:00.000Z"));
    expect(createCall.data.replyCount).toBe(0);
  });

  it("sets assignedToMe when thread has assignedTo", async () => {
    mockParse.mockReturnValue(makeNotification({
      comments: [makeCommentThread({ assignedTo: "you" })],
    }));
    mockComment.findFirst.mockResolvedValue(null);

    await mergeCommentsFromGmail("d1", "gdoc1", email);
    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.assignedToMe).toBe(true);
  });

  it("skips when googleCommentId already exists (idempotent)", async () => {
    mockParse.mockReturnValue(makeNotification());
    mockComment.findFirst.mockResolvedValue({ commentId: "existing" });

    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
    expect(mockComment.create).not.toHaveBeenCalled();
  });

  it("skips threads with no discussionId", async () => {
    mockParse.mockReturnValue(makeNotification({
      comments: [makeCommentThread({ discussionId: "" })],
    }));

    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
    expect(mockComment.create).not.toHaveBeenCalled();
  });

  it("skips threads whose discussionId is malformed, not just empty", async () => {
    // extractDiscoId is an unvalidated regex capture off the notification URL,
    // so a mangled link yields a non-empty but malformed value. Storing it
    // poisons googleCommentId exactly as the extension's old placeholder did:
    // it can never match, and it blocks the row from being repaired later.
    mockParse.mockReturnValue(makeNotification({
      comments: [makeCommentThread({ discussionId: "not-a-disco-id" })],
    }));

    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 0, shouldUnarchive: false });
    expect(mockComment.create).not.toHaveBeenCalled();
  });

  it("uses reply timestamps for created/modified dates", async () => {
    mockParse.mockReturnValue(makeNotification({
      comments: [makeCommentThread({
        replies: [
          { author: "Alice", time_str: "1:00 PM", time: "2026-03-20T13:00:00.000Z", text: "first", isNew: false },
          { author: "Bob", time_str: "2:00 PM", time: "2026-03-20T14:00:00.000Z", text: "second", isNew: false },
          { author: "Carol", time_str: "3:00 PM", time: "2026-03-20T15:00:00.000Z", text: "+someone@example.com", isNew: true },
        ],
      })],
    }));
    mockComment.findFirst.mockResolvedValue(null);

    await mergeCommentsFromGmail("d1", "gdoc1", email);
    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.driveCreatedAt).toEqual(new Date("2026-03-20T13:00:00.000Z"));
    expect(createCall.data.driveModifiedAt).toEqual(new Date("2026-03-20T15:00:00.000Z"));
    expect(createCall.data.replyCount).toBe(2);
  });

  it("falls back to email date when reply times are missing", async () => {
    mockParse.mockReturnValue(makeNotification({
      comments: [makeCommentThread({
        replies: [
          { author: "Alice", time_str: "unknown format", text: "hello", isNew: true },
        ],
      })],
    }));
    mockComment.findFirst.mockResolvedValue(null);

    await mergeCommentsFromGmail("d1", "gdoc1", email);
    const createCall = mockComment.create.mock.calls[0][0];
    expect(createCall.data.driveCreatedAt).toEqual(new Date("2026-03-20T15:00:00.000Z"));
    expect(createCall.data.driveModifiedAt).toEqual(new Date("2026-03-20T15:00:00.000Z"));
  });

  it("handles multiple comment threads in one notification", async () => {
    mockParse.mockReturnValue(makeNotification({
      comments: [
        makeCommentThread({ discussionId: "AAAB1aaa" }),
        makeCommentThread({ discussionId: "AAAB1bbb" }),
      ],
    }));
    mockComment.findFirst.mockResolvedValue(null);

    const result = await mergeCommentsFromGmail("d1", "gdoc1", email);
    expect(result).toEqual({ inserted: 2, shouldUnarchive: true });
    expect(mockComment.create).toHaveBeenCalledTimes(2);
  });
});

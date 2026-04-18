import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const comment = { findFirst: vi.fn(), update: vi.fn() };
  const doc = { findUnique: vi.fn() };
  return {
    prisma: {
      doc,
      comment,
      $executeRaw: vi.fn(),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ doc, comment, $executeRaw: vi.fn() })),
    },
  };
});
vi.mock("@/lib/sync-comments", () => ({
  bumpLastCommentActivity: vi.fn(),
  syncSingleComment: vi.fn(),
}));
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  const commentsGet = vi.fn();
  const filesGet = vi.fn().mockResolvedValue({ data: { viewedByMeTime: null } });
  return {
    getDriveClient: vi.fn(),
    createDriveService: vi.fn(() => ({ comments: { get: commentsGet }, files: { get: filesGet } })),
    fetchThreadDetail: vi.fn(),
    fetchDocData: vi.fn(),
    fetchCommentData: vi.fn(),
    invalidGrantResponse: vi.fn(() => null),
    // Pure helpers — use real implementations so error-code checks work
    isDriveErrorCode: actual.isDriveErrorCode,
    getDriveErrorCode: actual.getDriveErrorCode,
    _commentsGet: commentsGet,
    _filesGet: filesGet,
  };
});

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  fetchThreadDetail,
  fetchDocData,
  fetchCommentData,
} from "@/lib/google-drive";
import { syncSingleComment } from "@/lib/sync-comments";
import * as googleDriveMod from "@/lib/google-drive";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockGetDriveClient = vi.mocked(getDriveClient);
const mockFetchThreadDetail = vi.mocked(fetchThreadDetail);
const mockFetchDocData = vi.mocked(fetchDocData);
const mockFetchCommentData = vi.mocked(fetchCommentData);
const mockSyncSingleComment = vi.mocked(syncSingleComment);
// Access the mock comments.get via the helper we attached to the mock module
const mockCommentsGet = (googleDriveMod as unknown as { _commentsGet: ReturnType<typeof vi.fn> })
  ._commentsGet;
const mockFilesGet = (googleDriveMod as unknown as { _filesGet: ReturnType<typeof vi.fn> })
  ._filesGet;

function makeParams(docId: string) {
  return { params: Promise.resolve({ docId }) };
}

const docRecord = {
  docId: "d1",
  userId: "u1",
  googleDocId: "gdoc1",
  mimeType: "application/vnd.google-apps.document",
};

beforeEach(() => {
  vi.resetAllMocks();
});

// --------------- GET ---------------

describe("GET /api/docs/[docId]/threads", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/threads");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/threads");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when doc belongs to another user", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ ...docRecord, userId: "other" });
    const req = new NextRequest("http://localhost/api/docs/d1/threads");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns modifiedTime for checkOnly request", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockCommentsGet.mockResolvedValue({ data: { modifiedTime: "2024-06-15T00:00:00Z" } });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1&checkOnly=true"
    );
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.modifiedTime).toBe("2024-06-15T00:00:00Z");
  });

  it("returns single thread when commentId provided", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    const thread = { id: "c1", author: "Alice", fromMe: false, content: "Hi", createdTime: "", resolved: false, replies: [] };
    mockFetchThreadDetail.mockResolvedValue({
      comment: { id: "c1", resolved: false, isThreadAuthor: true, isReplyAuthor: false, iResolvedIt: false, isRead: false, assignedToMe: false, mentionedMe: false, mentionedMeUnreplied: false, driveCreatedAt: null, driveModifiedAt: null, replyCount: 0, replyAuthorMeFlags: [], replyMentionedMeFlags: [], replyAssignedToMeFlags: [] },
      thread,
    });

    const req = new NextRequest("http://localhost/api/docs/d1/threads?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads["c1"]).toBeDefined();
    expect(data.threads["c1"].author).toBe("Alice");
  });

  it("returns empty threads when fetchThreadDetail returns null", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchThreadDetail.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/docs/d1/threads?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    const data = await res.json();
    expect(Object.keys(data.threads)).toHaveLength(0);
  });

  it("returns all threads as record with viewedByMeTime when no commentId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchCommentData.mockResolvedValue({ threads: [
      { id: "c1", author: "A", fromMe: false, content: "x", createdTime: "", resolved: false, replies: [] },
      { id: "c2", author: "B", fromMe: false, content: "y", createdTime: "", resolved: true, replies: [] },
    ] });
    mockFilesGet.mockResolvedValue({ data: { viewedByMeTime: "2026-03-01T12:00:00Z" } });

    const req = new NextRequest("http://localhost/api/docs/d1/threads");
    const res = await GET(req, makeParams("d1"));
    const data = await res.json();
    expect(Object.keys(data.threads)).toHaveLength(2);
    expect(data.threads["c1"]).toBeDefined();
    expect(data.threads["c2"]).toBeDefined();
    expect(data.viewedByMeTime).toBe("2026-03-01T12:00:00Z");
  });

  it("returns 502 when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockRejectedValue(new Error("Drive error"));

    await suppressingErrors(async () => {
      const req = new NextRequest("http://localhost/api/docs/d1/threads");
      const res = await GET(req, makeParams("d1"));
      expect(res.status).toBe(502);
    });
  });
});

// --------------- POST ---------------

describe("POST /api/docs/[docId]/threads", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/threads", { method: "POST" });
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/threads", { method: "POST" });
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when commentId missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const req = new NextRequest("http://localhost/api/docs/d1/threads", { method: "POST" });
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/commentId/i);
  });

  it("returns 404 when comment record not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockComment.findFirst.mockResolvedValue(null);
    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("refreshes a comment and updates DB", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@test.com" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    const thread = { id: "c1", author: "Alice", fromMe: false, content: "Hi", createdTime: "", resolved: false, replies: [] };
    mockSyncSingleComment.mockResolvedValue({
      comment: { ...commentRecord, isThreadAuthor: true, replyCount: 2 } as any,
      thread,
      created: false, updated: true, deleted: false, shouldUnarchive: false,
    });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.isThreadAuthor).toBe(true);
    expect(Object.keys(data.threads)).toHaveLength(1);
  });

  it("auto-archives resolved comment when I resolved it", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@test.com" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    mockSyncSingleComment.mockResolvedValue({
      comment: { ...commentRecord, resolved: true, status: "ARCHIVED" } as any,
      thread: { id: "c1", author: "Me", fromMe: true, content: "Done", createdTime: "", resolved: true, replies: [] },
      created: false, updated: true, deleted: false, shouldUnarchive: false,
    });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    const data = await res.json();
    expect(data.comment.status).toBe("ARCHIVED");
  });

  it("preserves MUTED status even when resolved by me", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@test.com" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "MUTED", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    mockSyncSingleComment.mockResolvedValue({
      comment: { ...commentRecord, resolved: true, status: "MUTED" } as any,
      thread: { id: "c1", author: "X", fromMe: false, content: "y", createdTime: "", resolved: true, replies: [] },
      created: false, updated: true, deleted: false, shouldUnarchive: false,
    });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    const data = await res.json();
    expect(data.comment.status).toBe("MUTED");
  });

  it("marks suggestion as resolved when no longer live", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleSuggestionId: "suggest.abc",
      type: "SUGGESTION", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null }); // suggestion no longer live

    const updatedComment = { ...commentRecord, resolved: true, status: "ARCHIVED" };
    mockComment.update.mockResolvedValue(updatedComment);

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=suggest.abc",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    const data = await res.json();
    expect(data.comment.resolved).toBe(true);
    expect(data.comment.status).toBe("ARCHIVED");
  });

  it("returns suggestion unchanged when still live", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleSuggestionId: "suggest.abc",
      type: "SUGGESTION", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchDocData.mockResolvedValue({ suggestions: [
      { id: "suggest.abc", suggestionType: "EDIT", insertedText: "new", deletedText: "old" },
    ], suggestionContent: {}, documentText: null });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=suggest.abc",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    const data = await res.json();
    expect(data.comment.resolved).toBe(false);
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("preserves MUTED status for resolved suggestion", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleSuggestionId: "suggest.abc",
      type: "SUGGESTION", status: "MUTED", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchDocData.mockResolvedValue({ suggestions: [], suggestionContent: {}, documentText: null }); // no longer live

    mockComment.update.mockResolvedValue({ ...commentRecord, resolved: true, status: "MUTED" });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=suggest.abc",
      { method: "POST" }
    );
    await POST(req, makeParams("d1"));

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("MUTED");
  });

  it("skips suggestion check for non-Docs MIME type", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({
      ...docRecord,
      mimeType: "application/vnd.google-apps.spreadsheet",
    });
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleSuggestionId: "suggest.abc",
      type: "SUGGESTION", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=suggest.abc",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    const data = await res.json();
    expect(data.comment).toBeTruthy();
    expect(Object.keys(data.threads)).toHaveLength(0);
    expect(mockFetchDocData).not.toHaveBeenCalled();
  });

  it("returns 404 when comment deleted from Drive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@test.com" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockSyncSingleComment.mockResolvedValue({
      comment: null, deleted: true, created: false, updated: false, shouldUnarchive: false,
    });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 502 when Drive API fails for comment", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@test.com" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      commentId: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "INBOX", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockSyncSingleComment.mockRejectedValue(new Error("Drive error"));

    await suppressingErrors(async () => {
      const req = new NextRequest(
        "http://localhost/api/docs/d1/threads?commentId=c1",
        { method: "POST" }
      );
      const res = await POST(req, makeParams("d1"));
      expect(res.status).toBe(502);
    });
  });
});

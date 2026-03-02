import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: { findUnique: vi.fn() },
    comment: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("googleapis", () => {
  const commentsGet = vi.fn();
  return {
    google: {
      drive: () => ({ comments: { get: commentsGet } }),
      _commentsGet: commentsGet,
    },
  };
});
vi.mock("@/lib/google-drive", () => ({
  getDriveClient: vi.fn(),
  fetchThreadDetail: vi.fn(),
  fetchSuggestions: vi.fn(),
  fetchAllThreads: vi.fn(),
  invalidGrantResponse: vi.fn(() => null),
}));

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { google } from "googleapis";
import {
  getDriveClient,
  fetchThreadDetail,
  fetchSuggestions,
  fetchAllThreads,
} from "@/lib/google-drive";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockGetDriveClient = vi.mocked(getDriveClient);
const mockFetchThreadDetail = vi.mocked(fetchThreadDetail);
const mockFetchSuggestions = vi.mocked(fetchSuggestions);
const mockFetchAllThreads = vi.mocked(fetchAllThreads);
// Access the mock comments.get via the helper we attached
const mockCommentsGet = (google as unknown as { _commentsGet: ReturnType<typeof vi.fn> })
  ._commentsGet;

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const docRecord = {
  id: "d1",
  userId: "u1",
  googleDocId: "gdoc1",
  mimeType: "application/vnd.google-apps.document",
};

beforeEach(() => {
  vi.resetAllMocks();
});

// --------------- GET ---------------

describe("GET /api/docs/[id]/threads", () => {
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
    const thread = { id: "c1", author: "Alice", content: "Hi", createdTime: "", resolved: false, replies: [] };
    mockFetchThreadDetail.mockResolvedValue({
      resolved: false, isThreadAuthor: true, iParticipated: false, iResolvedIt: false,
      driveCreatedAt: null, driveModifiedAt: null, replyCount: 0,
      thread,
    });

    const req = new NextRequest("http://localhost/api/docs/d1/threads?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0].author).toBe("Alice");
  });

  it("returns empty threads when fetchThreadDetail returns null", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchThreadDetail.mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/docs/d1/threads?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    const data = await res.json();
    expect(data.threads).toHaveLength(0);
  });

  it("returns all threads when no commentId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchAllThreads.mockResolvedValue([
      { id: "c1", author: "A", content: "x", createdTime: "", resolved: false, replies: [] },
      { id: "c2", author: "B", content: "y", createdTime: "", resolved: true, replies: [] },
    ]);

    const req = new NextRequest("http://localhost/api/docs/d1/threads");
    const res = await GET(req, makeParams("d1"));
    const data = await res.json();
    expect(data.threads).toHaveLength(2);
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

describe("POST /api/docs/[id]/threads", () => {
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
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    const thread = { id: "c1", author: "Alice", content: "Hi", createdTime: "", resolved: false, replies: [] };
    mockFetchThreadDetail.mockResolvedValue({
      resolved: false, isThreadAuthor: true, iParticipated: false, iResolvedIt: false,
      driveCreatedAt: new Date("2024-06-01"), driveModifiedAt: new Date("2024-06-10"),
      replyCount: 2, thread,
    });
    const updatedComment = { ...commentRecord, isThreadAuthor: true, replyCount: 2 };
    mockComment.update.mockResolvedValue(updatedComment);

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.isThreadAuthor).toBe(true);
    expect(data.threads).toHaveLength(1);
  });

  it("auto-archives resolved comment when I resolved it", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    const thread = { id: "c1", author: "Me", content: "Done", createdTime: "", resolved: true, replies: [] };
    mockFetchThreadDetail.mockResolvedValue({
      resolved: true, isThreadAuthor: true, iParticipated: false, iResolvedIt: true,
      driveCreatedAt: null, driveModifiedAt: null, replyCount: 0, thread,
    });
    mockComment.update.mockResolvedValue({ ...commentRecord, resolved: true, status: "ARCHIVED" });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    await POST(req, makeParams("d1"));

    const updateCall = mockComment.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ARCHIVED");
  });

  it("preserves MUTED status even when resolved by me", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "MUTED", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);

    mockFetchThreadDetail.mockResolvedValue({
      resolved: true, isThreadAuthor: false, iParticipated: true, iResolvedIt: true,
      driveCreatedAt: null, driveModifiedAt: null, replyCount: 1,
      thread: { id: "c1", author: "X", content: "y", createdTime: "", resolved: true, replies: [] },
    });
    mockComment.update.mockResolvedValue({ ...commentRecord, resolved: true });

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    await POST(req, makeParams("d1"));

    const updateCall = mockComment.update.mock.calls[0][0];
    // status should NOT be in the update data — muted is preserved
    expect(updateCall.data.status).toBeUndefined();
  });

  it("marks suggestion as resolved when no longer live", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "suggest.abc",
      type: "SUGGESTION", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchSuggestions.mockResolvedValue([]); // suggestion no longer live

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
      id: "cr1", docId: "d1", googleCommentId: "suggest.abc",
      type: "SUGGESTION", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchSuggestions.mockResolvedValue([
      { id: "suggest.abc", suggestionType: "EDIT" },
    ]);

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
      id: "cr1", docId: "d1", googleCommentId: "suggest.abc",
      type: "SUGGESTION", status: "MUTED", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchSuggestions.mockResolvedValue([]); // no longer live

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
      id: "cr1", docId: "d1", googleCommentId: "suggest.abc",
      type: "SUGGESTION", status: "ACTIVE", resolved: false,
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
    expect(data.threads).toHaveLength(0);
    expect(mockFetchSuggestions).not.toHaveBeenCalled();
  });

  it("returns 404 when fetchThreadDetail returns null", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
    mockFetchThreadDetail.mockResolvedValue(null);

    const req = new NextRequest(
      "http://localhost/api/docs/d1/threads?commentId=c1",
      { method: "POST" }
    );
    const res = await POST(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 502 when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(docRecord);
    const commentRecord = {
      id: "cr1", docId: "d1", googleCommentId: "c1",
      type: "COMMENT", status: "ACTIVE", resolved: false,
    };
    mockComment.findFirst.mockResolvedValue(commentRecord);
    mockGetDriveClient.mockRejectedValue(new Error("Drive error"));

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

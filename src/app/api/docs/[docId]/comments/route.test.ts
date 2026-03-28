import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, fetchCommentData, fetchThreadDetail } from "@/lib/google-drive";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findUnique: vi.fn(),
    },
    comment: {
      updateMany: vi.fn(),
    },
  },
}));
const mockFilesGet = vi.fn();
vi.mock("@/lib/google-drive", () => ({
  getDriveClient: vi.fn(),
  createDriveService: vi.fn(() => ({ files: { get: mockFilesGet } })),
  fetchCommentData: vi.fn(),
  fetchThreadDetail: vi.fn(),
  invalidGrantResponse: vi.fn().mockReturnValue(null),
}));

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const mockComment = prisma.comment as unknown as {
  updateMany: ReturnType<typeof vi.fn>;
};
const mockFetchCommentData = vi.mocked(fetchCommentData);
const mockFetchThreadDetail = vi.mocked(fetchThreadDetail);

function makeParams(docId: string) {
  return { params: Promise.resolve({ docId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/docs/[docId]/comments", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/comments");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/comments");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 200 with threads and viewedByMeTime", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1", googleDocId: "g1" });
    mockFetchCommentData.mockResolvedValue({ threads: [
      { id: "c1", author: "A", fromMe: false, content: "C", createdTime: "T", resolved: false, replies: [] },
    ] });
    mockFilesGet.mockResolvedValue({ data: { viewedByMeTime: "2026-03-01T12:00:00Z" } });
    const req = new NextRequest("http://localhost/api/docs/d1/comments");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads["c1"]).toBeDefined();
    expect(data.viewedByMeTime).toBe("2026-03-01T12:00:00Z");
  });

  it("returns single thread when ?commentId is provided", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "test@example.com" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1", googleDocId: "g1" });
    mockFetchThreadDetail.mockResolvedValue({
      comment: { id: "c1", resolved: false, isThreadAuthor: false, isReplyAuthor: false, iResolvedIt: false, isRead: false, assignedToMe: false, mentionedMe: false, mentionedMeUnreplied: false, driveCreatedAt: new Date(), driveModifiedAt: new Date(), replyCount: 0, replyAuthorMeFlags: [], replyMentionedMeFlags: [] },
      thread: { id: "c1", author: "A", fromMe: false, content: "C", createdTime: "T", resolved: false, replies: [] },
    });
    const req = new NextRequest("http://localhost/api/docs/d1/comments?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads["c1"]).toBeDefined();
    expect(data.viewedByMeTime).toBeUndefined();
    expect(mockFetchCommentData).not.toHaveBeenCalled();
    expect(mockFetchThreadDetail).toHaveBeenCalledWith(undefined, "g1", "c1", "test@example.com");
  });

  it("returns empty threads when ?commentId comment is deleted (null result)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "test@example.com" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1", googleDocId: "g1" });
    mockFetchThreadDetail.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1/comments?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data.threads)).toHaveLength(0);
  });

  it("returns 502 when ?commentId comment throws (Drive 404)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "test@example.com" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1", googleDocId: "g1" });
    mockFetchThreadDetail.mockRejectedValue(Object.assign(new Error("Not Found"), { code: 404 }));
    const req = new NextRequest("http://localhost/api/docs/d1/comments?commentId=c1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(502);
  });
});

describe("PATCH /api/docs/[docId]/comments", () => {
  function makePatchReq(id: string, body: unknown): [NextRequest, ReturnType<typeof makeParams>] {
    const req = new NextRequest(`http://localhost/api/docs/${id}/comments`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    return [req, makeParams(id)];
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const [req, params] = makePatchReq("d1", { commentIds: ["c1"], status: "ARCHIVED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const [req, params] = makePatchReq("d1", { commentIds: ["c1"], status: "ARCHIVED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid commentIds", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const [req, params] = makePatchReq("d1", { commentIds: "not-array", status: "ARCHIVED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid status", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const [req, params] = makePatchReq("d1", { commentIds: ["c1"], status: "INVALID" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
  });

  it("returns 200 on successful bulk update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    mockComment.updateMany.mockResolvedValue({ count: 2 });
    const [req, params] = makePatchReq("d1", { commentIds: ["c1", "c2"], status: "ARCHIVED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(mockComment.updateMany).toHaveBeenCalledWith({
      where: {
        commentId: { in: ["c1", "c2"] },
        docId: "d1",
      },
      data: { status: "ARCHIVED" },
    });
  });
});

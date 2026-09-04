import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

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
    $executeRaw: vi.fn(),
  },
}));

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const mockComment = prisma.comment as unknown as {
  updateMany: ReturnType<typeof vi.fn>;
};
const mockExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;

function makeParams(docId: string) {
  return { params: Promise.resolve({ docId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
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

  // Marking read is the one branch that can't go through updateMany: it sets
  // read_message_count from each row's own reply_count.
  it("marks read via raw SQL so each thread gets its own message count", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    mockExecuteRaw.mockResolvedValue(2);

    const [req, params] = makePatchReq("d1", { commentIds: ["c1", "c2"], isRead: true });
    const res = await PATCH(req, params);

    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
    expect(mockComment.updateMany).not.toHaveBeenCalled();
    const sql = mockExecuteRaw.mock.calls[0][0].join("?");
    expect(sql).toContain("read_slot_count = reply_slot_count + 1");
    expect(sql).toContain("read_message_count = reply_count + 1");
  });

  it("marks unread by zeroing both read counts", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    mockComment.updateMany.mockResolvedValue({ count: 2 });

    const [req, params] = makePatchReq("d1", { commentIds: ["c1", "c2"], isRead: false });
    const res = await PATCH(req, params);

    expect(res.status).toBe(200);
    // Zero in both spaces, so there's no cross-column assignment and no need
    // to drop to raw SQL the way the read direction does.
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockComment.updateMany).toHaveBeenCalledWith({
      where: { commentId: { in: ["c1", "c2"] }, docId: "d1" },
      data: { readSlotCount: 0, readMessageCount: 0 },
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const p = {
    comment: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    doc: {
      update: vi.fn(),
    },
    $transaction: vi.fn((fn: (tx: typeof p) => Promise<unknown>) => fn(p)),
  };
  return { prisma: p };
});

import { PATCH } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockComment = prisma.comment as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockDoc = prisma.doc as unknown as {
  update: ReturnType<typeof vi.fn>;
};

function patchRequest(docId: string, commentId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/docs/${docId}/comments/${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (docId: string, commentId: string) =>
  Promise.resolve({ docId, commentId });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PATCH /api/docs/[docId]/comments/[commentId]", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(patchRequest("d1", "c1", { status: "INBOX" }), {
      params: params("d1", "c1"),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when comment not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockComment.findUnique.mockResolvedValue(null);
    const res = await PATCH(patchRequest("d1", "c1", { status: "INBOX" }), {
      params: params("d1", "c1"),
    });
    expect(res.status).toBe(404);
  });

  it("moves ARCHIVED doc to INBOX when comment is moved to INBOX", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockComment.findUnique.mockResolvedValue({
      commentId: "c1",
      docId: "d1",
      doc: { userId: "u1", status: "ARCHIVED" },
    });
    mockComment.update.mockResolvedValue({ commentId: "c1", status: "INBOX" });
    mockDoc.update.mockResolvedValue({});

    const res = await PATCH(patchRequest("d1", "c1", { status: "INBOX" }), {
      params: params("d1", "c1"),
    });
    expect(res.status).toBe(200);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { docId: "d1" },
      data: { status: "INBOX" },
    });
  });

  it("does NOT move doc when comment moved to INBOX but doc already INBOX", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockComment.findUnique.mockResolvedValue({
      commentId: "c1",
      docId: "d1",
      doc: { userId: "u1", status: "INBOX" },
    });
    mockComment.update.mockResolvedValue({ commentId: "c1", status: "INBOX" });

    const res = await PATCH(patchRequest("d1", "c1", { status: "INBOX" }), {
      params: params("d1", "c1"),
    });
    expect(res.status).toBe(200);
    expect(mockDoc.update).not.toHaveBeenCalled();
  });

  it("does NOT move doc when comment moved to ARCHIVED", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockComment.findUnique.mockResolvedValue({
      commentId: "c1",
      docId: "d1",
      doc: { userId: "u1", status: "ARCHIVED" },
    });
    mockComment.update.mockResolvedValue({ commentId: "c1", status: "ARCHIVED" });

    const res = await PATCH(patchRequest("d1", "c1", { status: "ARCHIVED" }), {
      params: params("d1", "c1"),
    });
    expect(res.status).toBe(200);
    expect(mockDoc.update).not.toHaveBeenCalled();
  });
});

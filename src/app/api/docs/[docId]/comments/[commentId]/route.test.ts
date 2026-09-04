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

  // isRead is the whole-thread form; the route translates it to a message count
  // using the reply count the DB has (see src/lib/read-state.ts).
  describe("isRead translation", () => {
    function existingComment(replyCount: number) {
      mockAuth.mockResolvedValue({ user: { id: "u1" } });
      mockComment.findUnique.mockResolvedValue({
        commentId: "c1",
        docId: "d1",
        replyCount,
        // No deleted replies in these fixtures, so slot space and render space
        // coincide — the shape of a thread nobody has deleted anything in.
        replySlotCount: replyCount,
        doc: { userId: "u1", status: "INBOX" },
      });
      mockComment.update.mockResolvedValue({ commentId: "c1" });
    }

    it("marks read as every message in the thread", async () => {
      existingComment(4);

      await PATCH(patchRequest("d1", "c1", { isRead: true }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 5, readMessageCount: 5 });
    });

    it("marks a reply-less thread read with just the head comment", async () => {
      existingComment(0);

      await PATCH(patchRequest("d1", "c1", { isRead: true }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 1, readMessageCount: 1 });
    });

    it("marks unread by zeroing the count", async () => {
      existingComment(4);

      await PATCH(patchRequest("d1", "c1", { isRead: false }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 0, readMessageCount: 0 });
    });

    it("leaves the read count alone when only status changes", async () => {
      existingComment(4);

      await PATCH(patchRequest("d1", "c1", { status: "ARCHIVED" }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).not.toHaveProperty("readSlotCount");
    });
  });

  // The per-message read-point controls send an absolute slot boundary instead,
  // converted by the client from the position it drew, paired with that
  // position itself as the render-space twin.
  describe("readSlotCount", () => {
    /** `replySlotCount` defaults to `replyCount`: no deleted replies, so slot
     *  space and render space coincide. Pass it explicitly to model a thread
     *  that has had a reply deleted. */
    function existingComment(replyCount: number, replySlotCount = replyCount) {
      mockAuth.mockResolvedValue({ user: { id: "u1" } });
      mockComment.findUnique.mockResolvedValue({
        commentId: "c1",
        docId: "d1",
        replyCount,
        // No deleted replies in these fixtures, so slot space and render space
        // coincide — the shape of a thread nobody has deleted anything in.
        replySlotCount,
        doc: { userId: "u1", status: "INBOX" },
      });
      mockComment.update.mockResolvedValue({ commentId: "c1" });
    }

    it("stores a partial count", async () => {
      existingComment(4);

      await PATCH(patchRequest("d1", "c1", { readSlotCount: 2, readMessageCount: 2 }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 2, readMessageCount: 2 });
    });

    it("stores zero as fully unread", async () => {
      existingComment(4);

      await PATCH(patchRequest("d1", "c1", { readSlotCount: 0, readMessageCount: 0 }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 0, readMessageCount: 0 });
    });

    // The client syncs the thread before sending a count past the stored size,
    // so this only bites when that sync couldn't run. Clamping keeps the stored
    // count from exceeding the thread; the client reports the shortfall.
    it("clamps a count past the thread's known size instead of rejecting", async () => {
      existingComment(2);

      const res = await PATCH(patchRequest("d1", "c1", { readSlotCount: 9, readMessageCount: 9 }), { params: params("d1", "c1") });

      expect(res.status).toBe(200);
      // Clamped at the stored slot total, which means "read to the end" — so the
      // render-space twin becomes the live total rather than what was asked for.
      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 3, readMessageCount: 3 });
    });

    // Two of the four replies were deleted, so the two counts genuinely differ:
    // 5 slots (head + 4) against 3 drawn messages (head + 2 live).
    it("stores each count in its own space on a thread with tombstones", async () => {
      existingComment(2, 4);

      await PATCH(patchRequest("d1", "c1", { readSlotCount: 5, readMessageCount: 3 }), { params: params("d1", "c1") });

      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 5, readMessageCount: 3 });
    });

    it("clamps each count to its own total on a thread with tombstones", async () => {
      existingComment(2, 4);

      const res = await PATCH(patchRequest("d1", "c1", { readSlotCount: 9, readMessageCount: 9 }), { params: params("d1", "c1") });

      expect(res.status).toBe(200);
      // Pulled back to the slot total, which means "read to the end", so the
      // twin becomes the live total (3) rather than the 9 that was asked for.
      expect(mockComment.update.mock.calls[0][0].data).toEqual({ readSlotCount: 5, readMessageCount: 3 });
    });

    // The live messages below a boundary are a subset of the slots below it, so
    // this pair can't describe any real thread: it means a client bug.
    it("rejects a render count above the slot count", async () => {
      existingComment(2, 4);

      const res = await PATCH(patchRequest("d1", "c1", { readSlotCount: 2, readMessageCount: 3 }), { params: params("d1", "c1") });

      expect(res.status).toBe(400);
      expect(mockComment.update).not.toHaveBeenCalled();
    });

    it("rejects either count sent without the other", async () => {
      existingComment(4);

      const slotOnly = await PATCH(patchRequest("d1", "c1", { readSlotCount: 2 }), { params: params("d1", "c1") });
      const renderOnly = await PATCH(patchRequest("d1", "c1", { readMessageCount: 2 }), { params: params("d1", "c1") });

      expect(slotOnly.status).toBe(400);
      expect(renderOnly.status).toBe(400);
      expect(mockComment.update).not.toHaveBeenCalled();
    });

    it("rejects a negative count", async () => {
      existingComment(4);

      const res = await PATCH(patchRequest("d1", "c1", { readSlotCount: -1, readMessageCount: 0 }), { params: params("d1", "c1") });

      expect(res.status).toBe(400);
      expect(mockComment.update).not.toHaveBeenCalled();
    });

    it("rejects a non-integer count", async () => {
      existingComment(4);

      const res = await PATCH(patchRequest("d1", "c1", { readSlotCount: 1.5, readMessageCount: 0 }), { params: params("d1", "c1") });

      expect(res.status).toBe(400);
      expect(mockComment.update).not.toHaveBeenCalled();
    });

    it("rejects isRead and readSlotCount together", async () => {
      existingComment(4);

      const res = await PATCH(patchRequest("d1", "c1", { isRead: true, readSlotCount: 2 }), {
        params: params("d1", "c1"),
      });

      expect(res.status).toBe(400);
      expect(mockComment.update).not.toHaveBeenCalled();
    });
  });
});

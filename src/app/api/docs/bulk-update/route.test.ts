import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DocRole, DocStatus } from "@prisma/client";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { PATCH } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PATCH /api/docs/bulk-update", () => {
  function makeReq(body: unknown) {
    return new NextRequest("http://localhost/api/docs/bulk-update", {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(makeReq({ docIds: ["d1"] }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty docIds", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when docIds exceeds 500", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const ids = Array.from({ length: 501 }, (_, i) => `d${i}`);
    const res = await PATCH(makeReq({ docIds: ids, role: "as-is", status: "as-is", labelUpdates: {} }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/too many/i);
  });

  it("returns 400 for non-string docIds", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: [123], role: "as-is", status: "as-is", labelUpdates: {} }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: ["d1"], role: "bogus", status: "as-is", labelUpdates: {} }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/role/i);
  });

  it("returns 400 for invalid status state", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: ["d1"], role: "as-is", status: "bogus", labelUpdates: {} }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/status/i);
  });

  it("returns 400 for invalid labelUpdates", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: ["d1"], role: "as-is", status: "as-is", labelUpdates: { l1: "bogus" } }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string appendNotes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await PATCH(makeReq({ docIds: ["d1"], role: "as-is", status: "as-is", labelUpdates: {}, appendNotes: 42 }));
    expect(res.status).toBe(400);
  });

  it("performs no update when role, status, and labels are 'as-is' and no notes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.AUTHOR,
      status: DocStatus.INBOX,
      labels: [{ labelId: "l1" }],
      comments: [],
    };
    mockDoc.findMany.mockResolvedValue([doc]);

    const res = await PATCH(makeReq({
      docIds: ["d1"],
      role: "as-is",
      status: "as-is",
      labelUpdates: { l1: "as-is" },
      appendNotes: ""
    }));

    expect(res.status).toBe(200);
    // No writes should happen — $transaction should not be called with any updates
    expect(mockTransaction).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.docs[0].id).toBe("d1");
    expect(data.skipped).toBe(0);
  });

  it("updates role and appends notes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.REVIEWER,
      status: DocStatus.INBOX,
      notes: "First line",
      labels: [],
      comments: [],
    };
    mockDoc.findMany.mockResolvedValue([doc]);
    const updatedDoc = {
      ...doc,
      role: DocRole.AUTHOR,
      notes: "First line\nSecond line",
    };
    mockTransaction.mockResolvedValue([updatedDoc]);

    const res = await PATCH(makeReq({
      docIds: ["d1"],
      role: "set",
      status: "as-is",
      labelUpdates: {},
      appendNotes: "Second line"
    }));

    expect(res.status).toBe(200);
    expect(mockDoc.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "d1" },
      data: expect.objectContaining({
        role: DocRole.AUTHOR,
        notes: "First line\nSecond line"
      })
    }));
  });

  it("updates status to ARCHIVED", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      status: DocStatus.INBOX,
      labels: [],
      comments: [],
    };
    mockDoc.findMany.mockResolvedValue([doc]);
    mockTransaction.mockResolvedValue([{ ...doc, status: DocStatus.ARCHIVED }]);

    const res = await PATCH(makeReq({
      docIds: ["d1"],
      role: "as-is",
      status: "clear",
      labelUpdates: {},
    }));

    expect(res.status).toBe(200);
    expect(mockDoc.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: DocStatus.ARCHIVED }),
    }));
  });

  it("reports skipped count for docs not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.AUTHOR,
      status: DocStatus.INBOX,
      labels: [],
      comments: [],
    };
    // Request 3 docs but only 1 found (d2 and d3 belong to another user or don't exist)
    mockDoc.findMany.mockResolvedValue([doc]);

    const res = await PATCH(makeReq({
      docIds: ["d1", "d2", "d3"],
      role: "as-is",
      status: "as-is",
      labelUpdates: {},
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.skipped).toBe(2);
    expect(data.docs).toHaveLength(1);
  });

  it("adds and removes labels", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.AUTHOR,
      status: DocStatus.INBOX,
      labels: [{ labelId: "l1" }],
      comments: [],
    };
    mockDoc.findMany.mockResolvedValue([doc]);
    mockTransaction.mockResolvedValue([{
      ...doc,
      labels: [{ labelId: "l2" }],
    }]);

    const res = await PATCH(makeReq({
      docIds: ["d1"],
      role: "as-is",
      status: "as-is",
      labelUpdates: {
        l1: "clear",
        l2: "set",
        l3: "as-is"
      }
    }));

    expect(res.status).toBe(200);
    expect(mockDoc.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        labels: {
          create: [{ labelId: "l2" }],
          deleteMany: { labelId: { in: ["l1"] } }
        }
      })
    }));
  });
});

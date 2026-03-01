import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DocRole } from "@prisma/client";

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

  it("performs no update when role and labels are 'as-is' and no notes", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.AUTHOR,
      labels: [{ labelId: "l1" }],
      comments: [],
    };
    mockDoc.findMany.mockResolvedValue([doc]);

    const res = await PATCH(makeReq({
      docIds: ["d1"],
      role: "as-is",
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

  it("adds and removes labels", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = {
      id: "d1",
      userId: "u1",
      role: DocRole.AUTHOR,
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

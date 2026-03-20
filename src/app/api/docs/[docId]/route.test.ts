import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    label: {
      findMany: vi.fn(),
    },
  },
}));

import { GET, PATCH } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockLabel = prisma.label as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};

function makeParams(docId: string) {
  return { params: Promise.resolve({ docId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/docs/[docId]", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/d1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when doc belongs to another user", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "other-user" });
    const req = new NextRequest("http://localhost/api/docs/d1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("returns 200 with doc data for owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const doc = { docId: "d1", userId: "u1", title: "Test", labels: [], comments: [] };
    mockDoc.findUnique.mockResolvedValue(doc);
    const req = new NextRequest("http://localhost/api/docs/d1");
    const res = await GET(req, makeParams("d1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe(""); // stripTitle() clears titles from API responses
  });
});

describe("PATCH /api/docs/[docId]", () => {
  function makePatchReq(id: string, body: unknown): [NextRequest, ReturnType<typeof makeParams>] {
    const req = new NextRequest(`http://localhost/api/docs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    return [req, makeParams(id)];
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const [req, params] = makePatchReq("d1", { role: "AUTHOR" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(401);
  });

  it("returns 404 when doc not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue(null);
    const [req, params] = makePatchReq("d1", { role: "AUTHOR" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const req = new NextRequest("http://localhost/api/docs/d1", {
      method: "PATCH",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    const res = await PATCH(req, makeParams("d1"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid json/i);
  });

  it("returns 400 for invalid role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const [req, params] = makePatchReq("d1", { role: "INVALID" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid role/i);
  });

  it("returns 400 for invalid status", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const [req, params] = makePatchReq("d1", { status: "DELETED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid status/i);
  });

  it("returns 400 for non-array labelIds", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const [req, params] = makePatchReq("d1", { labelIds: "not-array" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid labelIds/i);
  });

  it("returns 400 when labelIds include unowned label", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    // Only 1 of 2 labels found → means one isn't owned by user
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]);
    const [req, params] = makePatchReq("d1", { labelIds: ["l1", "l2"] });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid label/i);
  });

  it("returns 200 on successful role update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const updatedDoc = { docId: "d1", userId: "u1", role: "AUTHOR", labels: [], comments: [] };
    mockDoc.update.mockResolvedValue(updatedDoc);
    const [req, params] = makePatchReq("d1", { role: "AUTHOR" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.role).toBe("AUTHOR");
  });

  it("returns 200 on successful status update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const updatedDoc = { docId: "d1", userId: "u1", status: "ARCHIVED", labels: [], comments: [] };
    mockDoc.update.mockResolvedValue(updatedDoc);
    const [req, params] = makePatchReq("d1", { status: "ARCHIVED" });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ARCHIVED");
  });

  it("returns 200 on successful label update with empty array", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValue({ docId: "d1", userId: "u1" });
    const updatedDoc = { docId: "d1", userId: "u1", labels: [], comments: [] };
    mockDoc.update.mockResolvedValue(updatedDoc);
    const [req, params] = makePatchReq("d1", { labelIds: [] });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    // Should not have checked label ownership for empty array
    expect(mockLabel.findMany).not.toHaveBeenCalled();
  });
});

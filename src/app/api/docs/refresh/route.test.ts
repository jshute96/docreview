import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive", () => ({
  fetchDocsByIds: vi.fn(),
  getDriveClient: vi.fn(),
  invalidGrantResponse: vi.fn(() => null),
  isInvalidGrantError: vi.fn(() => false),
}));
vi.mock("@/lib/sync-comments", () => ({
  syncComments: vi.fn(),
}));
vi.mock("@/lib/refresh", () => ({
  executeRefresh: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { executeRefresh } from "@/lib/refresh";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};
const mockExecuteRefresh = vi.mocked(executeRefresh);

beforeEach(() => {
  vi.resetAllMocks();
});

/** Parse an SSE response and return the result data. */
async function readSSEResult<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  for (const part of text.split("\n\n")) {
    const lines = part.split("\n");
    let eventType = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventType = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (eventType === "result" && data) return JSON.parse(data);
    if (eventType === "error" && data) {
      const err = JSON.parse(data);
      throw new Error(err.message || "SSE error");
    }
  }
  throw new Error("No result event in SSE stream");
}

function postWithBody(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/docs/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/docs/refresh", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/refresh", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("discovery refresh passes sources to executeRefresh", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u@test.com" } });
    mockExecuteRefresh.mockResolvedValue({
      added: 0, updated: 1, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0,
    });

    const res = await POST(postWithBody({ sources: ["drive"] }));
    const data = await readSSEResult(res);
    expect(data.updated).toBe(1);
    expect(mockExecuteRefresh).toHaveBeenCalledWith("u1", "u@test.com", {
      drive: true,
      gmail: false,
      onProgress: expect.any(Function),
    });
  });

  it("defaults to both drive and gmail sources", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockExecuteRefresh.mockResolvedValue({
      added: 0, updated: 0, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0,
    });

    const req = new NextRequest("http://localhost/api/docs/refresh", { method: "POST" });
    await POST(req);
    expect(mockExecuteRefresh).toHaveBeenCalledWith("u1", undefined, {
      drive: true,
      gmail: true,
      onProgress: expect.any(Function),
    });
  });

  it("full refresh mode fetches all tracked docs and passes googleDocIds", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u@test.com" } });
    mockDoc.findMany.mockResolvedValue([
      { googleDocId: "g1" },
      { googleDocId: "g2" },
    ]);
    mockExecuteRefresh.mockResolvedValue({
      added: 0, updated: 2, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0,
    });

    const res = await POST(postWithBody({ mode: "full" }));
    const data = await readSSEResult(res);
    expect(data.updated).toBe(2);
    expect(mockDoc.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { googleDocId: true },
    });
    expect(mockExecuteRefresh).toHaveBeenCalledWith("u1", "u@test.com", {
      googleDocIds: ["g1", "g2"],
      mode: "full-refresh",
      onProgress: expect.any(Function),
    });
  });

  it("full refresh with no tracked docs passes empty array", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findMany.mockResolvedValue([]);
    mockExecuteRefresh.mockResolvedValue({
      added: 0, updated: 0, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0,
    });

    const res = await POST(postWithBody({ mode: "full" }));
    const data = await readSSEResult(res);
    expect(data.added).toBe(0);
    expect(mockExecuteRefresh).toHaveBeenCalledWith("u1", undefined, {
      googleDocIds: [],
      mode: "full-refresh",
      onProgress: expect.any(Function),
    });
  });

  it("selected refresh converts docIds and uses selected mode", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "u@test.com" } });
    mockDoc.findMany.mockResolvedValue([
      { googleDocId: "g1" },
    ]);
    mockExecuteRefresh.mockResolvedValue({
      added: 0, updated: 1, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0,
    });

    const res = await POST(postWithBody({ docIds: ["d1"] }));
    const data = await readSSEResult(res);
    expect(data.updated).toBe(1);
    expect(mockDoc.findMany).toHaveBeenCalledWith({
      where: { userId: "u1", docId: { in: ["d1"] } },
      select: { googleDocId: true },
    });
    expect(mockExecuteRefresh).toHaveBeenCalledWith("u1", "u@test.com", {
      googleDocIds: ["g1"],
      mode: "selected",
      onProgress: expect.any(Function),
    });
  });

  it("returns 400 for invalid sources", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(postWithBody({ sources: ["invalid"] }));
    expect(res.status).toBe(400);
  });
});

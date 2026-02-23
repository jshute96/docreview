import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    label: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockLabel = prisma.label as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/labels", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns labels ordered by position", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const labels = [
      { id: "l1", name: "Bug", color: "#ff0000", position: 0, userId: "u1" },
      { id: "l2", name: "Feature", color: "#00ff00", position: 1, userId: "u1" },
    ];
    mockLabel.findMany.mockResolvedValue(labels);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(labels);
    expect(mockLabel.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { position: "asc" },
    });
  });
});

describe("POST /api/labels", () => {
  function makeReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/labels", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeReq({ name: "Bug" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/name/i);
  });

  it("returns 400 for whitespace-only name", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const res = await POST(makeReq({ name: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 409 for duplicate name (P2002)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.0.0",
    });
    mockLabel.create.mockRejectedValue(p2002);

    const res = await POST(makeReq({ name: "Bug" }));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already exists/i);
  });

  it("returns 201 on success", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const label = { id: "l1", name: "Bug", color: null, position: 0, userId: "u1" };
    mockLabel.create.mockResolvedValue(label);

    const res = await POST(makeReq({ name: "Bug" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual(label);
  });

  it("trims the name", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockLabel.create.mockResolvedValue({ id: "l1", name: "Bug", color: null, position: 0, userId: "u1" });

    await POST(makeReq({ name: "  Bug  " }));
    expect(mockLabel.create).toHaveBeenCalledWith({
      data: { userId: "u1", name: "Bug", color: null },
    });
  });

  it("passes color when provided", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockLabel.create.mockResolvedValue({ id: "l1", name: "Bug", color: "#ff0000", position: 0, userId: "u1" });

    await POST(makeReq({ name: "Bug", color: "#ff0000" }));
    expect(mockLabel.create).toHaveBeenCalledWith({
      data: { userId: "u1", name: "Bug", color: "#ff0000" },
    });
  });
});

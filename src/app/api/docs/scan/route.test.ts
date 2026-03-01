import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive", () => ({
  listRecentDocs: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs } from "@/lib/google-drive";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};
const mockListRecentDocs = vi.mocked(listRecentDocs);

beforeEach(() => {
  vi.resetAllMocks();
});

function scanRequest(body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/docs/scan", {
    method: "POST",
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

describe("POST /api/docs/scan", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(scanRequest());
    expect(res.status).toBe(401);
  });

  it("returns total, existingCount, and newDocs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date(),
        createdTimeInDrive: new Date(),
        owner: "Owner",
      },
      {
        googleDocId: "g2",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g2/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date(),
        createdTimeInDrive: new Date(),
        owner: "Someone",
      },
    ]);
    // g1 already in DB
    mockDoc.findMany.mockResolvedValue([{ googleDocId: "g1" }]);

    const res = await POST(scanRequest({ daysBack: 14 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.existingCount).toBe(1);
    expect(data.newDocs).toHaveLength(1);
    expect(data.newDocs[0].googleDocId).toBe("g2");
    expect(data.newDocs[0].title).toBe("New Doc");
    expect(data.newDocs[0].role).toBe("REVIEWER");
  });

  it("passes options to listRecentDocs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockResolvedValue([]);
    mockDoc.findMany.mockResolvedValue([]);

    await POST(scanRequest({ daysBack: 7, ownership: "owned", includeSharedDrives: true }));

    expect(mockListRecentDocs).toHaveBeenCalledWith(
      "u1",
      expect.any(Date),
      { ownership: "owned", includeSharedDrives: true },
    );
  });

  it("returns 502 when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockRejectedValue(new Error("Drive error"));

    await suppressingErrors(async () => {
      const res = await POST(scanRequest());
      expect(res.status).toBe(502);
    });
  });

  it("works with no request body", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockResolvedValue([]);
    mockDoc.findMany.mockResolvedValue([]);

    const res = await POST(scanRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(0);
    expect(data.newDocs).toEqual([]);
  });
});

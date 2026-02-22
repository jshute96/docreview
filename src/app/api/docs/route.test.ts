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
      update: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive", () => ({
  listRecentDocs: vi.fn(),
  findDeletedDocIds: vi.fn(),
  getDriveClient: vi.fn(),
}));
vi.mock("@/lib/sync-comments", () => ({
  syncComments: vi.fn(),
}));

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds, getDriveClient } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";

const mockAuth = vi.mocked(auth);
const mockDoc = prisma.doc as {
  findMany: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockListRecentDocs = vi.mocked(listRecentDocs);
const mockFindDeletedDocIds = vi.mocked(findDeletedDocIds);
const mockGetDriveClient = vi.mocked(getDriveClient);
const mockSyncComments = vi.mocked(syncComments);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/docs", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns docs excluding archived by default", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    const docs = [{ id: "d1", title: "Active Doc" }];
    mockDoc.findMany.mockResolvedValue(docs);

    const req = new NextRequest("http://localhost/api/docs");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1", status: "ACTIVE" });
  });

  it("includes archived when includeArchived=true", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    mockDoc.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/docs?includeArchived=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1" });
  });

  it("filters by labelId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    mockDoc.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/docs?labelId=l1&labelId=l2");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where.labels).toEqual({ some: { labelId: { in: ["l1", "l2"] } } });
  });
});

describe("POST /api/docs", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 502 when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    mockListRecentDocs.mockRejectedValue(new Error("Drive unavailable"));

    const res = await POST();
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toMatch(/google drive/i);
  });

  it("syncs docs and returns counts", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    // Pre-fetch: no existing docs (so g1 is an "add")
    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds query
      .mockResolvedValueOnce([]) // missingDocs query (no docs missing from Drive)
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue(0);

    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.added).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.deleted).toBe(0);
    expect(data.total).toBe(1);
    expect(data.comments).toBe(0);
  });

  it("counts updated docs when they already exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: null,
        owner: null,
      },
    ]);

    // g1 already exists
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]) // missingDocs
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue(0);

    const res = await POST();
    const data = await res.json();
    expect(data.added).toBe(0);
    expect(data.updated).toBe(1);
  });

  it("marks deleted docs from Drive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } } as Awaited<ReturnType<typeof auth>>);
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([]); // no docs from Drive

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([{ id: "d1", googleDocId: "g1" }]) // missingDocs — one doc not in Drive
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockFindDeletedDocIds.mockResolvedValue(new Set(["g1"]));
    mockDoc.update.mockResolvedValue({});
    mockSyncComments.mockResolvedValue(0);

    const res = await POST();
    const data = await res.json();
    expect(data.deleted).toBe(1);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { isDeleted: true },
    });
  });
});

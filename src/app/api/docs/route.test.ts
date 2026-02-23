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
vi.mock("@/lib/status", () => ({
  getStatus: vi.fn(),
  updateDriveTimestamp: vi.fn(),
}));

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds, getDriveClient } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateDriveTimestamp } from "@/lib/status";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockListRecentDocs = vi.mocked(listRecentDocs);
const mockFindDeletedDocIds = vi.mocked(findDeletedDocIds);
const mockGetDriveClient = vi.mocked(getDriveClient);
const mockSyncComments = vi.mocked(syncComments);
const mockGetStatus = vi.mocked(getStatus);
const mockUpdateDriveTimestamp = vi.mocked(updateDriveTimestamp);

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
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const docs = [{ id: "d1", title: "Active Doc" }];
    mockDoc.findMany.mockResolvedValue(docs);

    const req = new NextRequest("http://localhost/api/docs");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1", status: "ACTIVE" });
  });

  it("includes archived when includeArchived=true", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/docs?includeArchived=true");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1" });
  });

  it("filters by labelId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/docs?labelId=l1&labelId=l2");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where.labels).toEqual({ some: { labelId: { in: ["l1", "l2"] } } });
  });
});

function postRequest(mode?: "refresh" | "full-refresh" | "load") {
  const url = mode
    ? `http://localhost/api/docs?mode=${mode}`
    : "http://localhost/api/docs";
  return new NextRequest(url, { method: "POST" });
}

describe("POST /api/docs", () => {
  beforeEach(() => {
    mockGetStatus.mockResolvedValue(null);
    mockUpdateDriveTimestamp.mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
  });

  it("returns 502 when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockRejectedValue(new Error("Drive unavailable"));

    await suppressingErrors(async () => {
      const res = await POST(postRequest());
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toMatch(/google drive/i);
    });
  });

  it("syncs docs and returns counts (load mode)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
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
      .mockResolvedValueOnce([]); // activeDocs for comment sync (scoped to Drive-returned docs)
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("load"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe("load");
    expect(data.added).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.deleted).toBe(0);
    expect(data.total).toBe(1);
    expect(data.comments).toBe(0);
  });

  it("counts updated docs when they already exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
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
      .mockResolvedValueOnce([]); // activeDocs for comment sync (scoped to Drive-returned docs)
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("load"));
    const data = await res.json();
    expect(data.added).toBe(0);
    expect(data.updated).toBe(1);
  });

  it("marks deleted docs from Drive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([]); // no docs from Drive

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([{ id: "d1", googleDocId: "g1" }]) // missingDocs — one doc not in Drive
      .mockResolvedValueOnce([]); // activeDocs for comment sync (scoped to Drive-returned docs)
    mockFindDeletedDocIds.mockResolvedValue(new Set(["g1"]));
    mockDoc.update.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("load"));
    const data = await res.json();
    expect(data.deleted).toBe(1);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { isDeleted: true },
    });
  });

  it("full-refresh mode syncs comments for all non-deleted docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    // Drive returns one doc (g1), but DB has two non-deleted docs (g1, g2)
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Doc One",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    const dbDoc1 = { id: "d1", googleDocId: "g1" };
    const dbDoc2 = { id: "d2", googleDocId: "g2" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }, { googleDocId: "g2" }]) // existingDocIds
      .mockResolvedValueOnce([dbDoc1, dbDoc2]); // activeDocs for comment sync (all non-deleted)
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("full-refresh"));
    const data = await res.json();
    expect(data.mode).toBe("full-refresh");
    expect(data.updated).toBe(1); // g1 updated, g2 not in Drive results so not upserted
    expect(data.added).toBe(0); // g1 already existed in DB
    // Full-refresh uses incremental timestamp
    expect(mockGetStatus).toHaveBeenCalledWith("u1");
    // Comment sync called for both docs (full-refresh syncs all)
    expect(mockSyncComments).toHaveBeenCalledTimes(2);
  });

  it("full-refresh mode auto-adds new AUTHOR docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "My New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds — g1 not in DB
      .mockResolvedValueOnce([]); // activeDocs for comment sync (all non-deleted)
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("full-refresh"));
    const data = await res.json();
    expect(data.mode).toBe("full-refresh");
    expect(data.added).toBe(1);
    expect(mockDoc.upsert).toHaveBeenCalledTimes(1);
  });

  it("refresh mode auto-adds new AUTHOR docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "My New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds — g1 not in DB
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("refresh"));
    const data = await res.json();
    expect(data.mode).toBe("refresh");
    expect(data.added).toBe(1);
    expect(mockDoc.upsert).toHaveBeenCalledTimes(1);
  });

  it("refresh mode skips new REVIEWER docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Someone Else's Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Someone",
      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds — g1 not in DB, skipped as REVIEWER
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("refresh"));
    const data = await res.json();
    expect(data.mode).toBe("refresh");
    expect(data.added).toBe(0);
    expect(data.updated).toBe(0);
    expect(mockDoc.upsert).not.toHaveBeenCalled();
  });

  it("unarchives archived doc when syncComments signals shouldUnarchive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Archived Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    const archivedDoc = { id: "d1", googleDocId: "g1", status: "ARCHIVED" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]) // missingDocs
      .mockResolvedValueOnce([archivedDoc]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({});
    mockDoc.update.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 1, shouldUnarchive: true });

    const res = await POST(postRequest("load"));
    const data = await res.json();
    expect(data.unarchived).toBe(1);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { id: "d1" },
      data: { status: "ACTIVE" },
    });
  });

  it("keeps archived doc archived when syncComments does not signal unarchive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockListRecentDocs.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Archived Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),
        owner: "Owner",
      },
    ]);

    const archivedDoc = { id: "d1", googleDocId: "g1", status: "ARCHIVED" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]) // missingDocs
      .mockResolvedValueOnce([archivedDoc]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({ created: 0, shouldUnarchive: false });

    const res = await POST(postRequest("load"));
    const data = await res.json();
    expect(data.unarchived).toBe(0);
    // doc.update should NOT have been called to unarchive
    expect(mockDoc.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ACTIVE" } })
    );
  });
});

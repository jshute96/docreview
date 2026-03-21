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
    label: {
      findMany: vi.fn(),
    },
    docLabel: {
      createMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive", () => ({
  listRecentDocs: vi.fn(),
  fetchDocsByIds: vi.fn(),
  findDeletedOrDeniedDocIds: vi.fn(),
  getDriveClient: vi.fn(),
  getChangesStartPageToken: vi.fn(),
  listChanges: vi.fn(),
  invalidGrantResponse: vi.fn(() => null),
  isInvalidGrantError: vi.fn(() => false),
}));
vi.mock("@/lib/sync-comments", () => ({
  syncComments: vi.fn(),
}));
vi.mock("@/lib/status", () => ({
  getStatus: vi.fn(),
  updateDriveChangesToken: vi.fn(),
}));

import { GET, POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { fetchDocsByIds, getDriveClient, getChangesStartPageToken } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { updateDriveChangesToken } from "@/lib/status";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mockLabel = prisma.label as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};
const mockDocLabel = prisma.docLabel as unknown as {
  createMany: ReturnType<typeof vi.fn>;
};
const mockFetchDocsByIds = vi.mocked(fetchDocsByIds);
const mockGetDriveClient = vi.mocked(getDriveClient);
const mockGetChangesStartPageToken = vi.mocked(getChangesStartPageToken);
const mockSyncComments = vi.mocked(syncComments);
const mockUpdateDriveChangesToken = vi.mocked(updateDriveChangesToken);

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
    const docs = [{ docId: "d1", title: "Active Doc", comments: [] }];
    mockDoc.findMany.mockResolvedValue(docs);

    const req = new NextRequest("http://localhost/api/docs");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockDoc.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ userId: "u1", status: "INBOX" });
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

function postRequest(mode?: "full-refresh" | "load") {
  const url = mode
    ? `http://localhost/api/docs?mode=${mode}`
    : "http://localhost/api/docs";
  return new NextRequest(url, { method: "POST" });
}

function postRequestWithBody(mode: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/docs?mode=${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Parse an SSE response and return the result data. Throws if an error event is found. */
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

describe("POST /api/docs", () => {
  beforeEach(() => {
    mockUpdateDriveChangesToken.mockResolvedValue(undefined);
    mockGetChangesStartPageToken.mockResolvedValue("token-1");
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
  });

  it("returns error when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockGetDriveClient.mockRejectedValue(new Error("Drive unavailable"));

    await suppressingErrors(async () => {
      const res = await POST(postRequest());
      await expect(readSSEResult(res)).rejects.toThrow();
    });
  });

  it("syncs docs and returns counts (load mode)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    // Pre-fetch: no existing docs (so g1 is an "add")
    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds query
      .mockResolvedValueOnce([]); // activeDocs for comment sync (scoped to fetched docs)
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    expect(res.status).toBe(200);
    const data = await readSSEResult(res);
    expect(data.mode).toBe("load");
    expect(data.added).toBe(1);
    expect(data.updated).toBe(0);
    expect(data.deleted).toBe(0);
    expect(data.total).toBe(1);
  });

  it("counts updated docs when they already exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: null,

      },
    ]);

    // g1 already exists
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    const data = await readSSEResult(res);
    expect(data.added).toBe(0);
    expect(data.updated).toBe(1);
  });

  it("load mode fetches only selected docs by ID", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // activeDocs for comment sync
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1", "g2"],
    }));
    expect(mockFetchDocsByIds).toHaveBeenCalledWith("u1", ["g1", "g2"], expect.any(Function));
  });

  it("full-refresh mode syncs comments for all non-deleted docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    // Drive returns metadata for both docs
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Doc One",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),

      },
      {
        googleDocId: "g2",
        title: "Doc Two",
        driveUrl: "https://docs.google.com/document/d/g2/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),

      },
    ]);

    const dbDoc1 = { docId: "d1", googleDocId: "g1" };
    const dbDoc2 = { docId: "d2", googleDocId: "g2" };
    mockDoc.findMany
      .mockResolvedValueOnce([dbDoc1, dbDoc2]) // route.ts: fetch all googleDocIds
      .mockResolvedValueOnce([dbDoc1, dbDoc2]) // executeDirectRefresh: existingDocIds
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequest("full-refresh"));
    const data = await readSSEResult(res);
    expect(data.mode).toBe("full-refresh");
    expect(data.updated).toBe(2); // Both docs updated
    expect(data.added).toBe(0);
    expect(mockSyncComments).toHaveBeenCalledTimes(2);
  });

  it("full-refresh mode does NOT auto-add new docs (scan removed)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // route.ts: fetch all googleDocIds (empty)

    const res = await POST(postRequest("full-refresh"));
    const data = await readSSEResult(res);
    expect(data.mode).toBe("full-refresh");
    expect(data.added).toBe(0);
    expect(mockFetchDocsByIds).not.toHaveBeenCalled();
  });

  it("unarchives archived doc when syncComments signals shouldUnarchive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Archived Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    const archivedDoc = { docId: "d1", googleDocId: "g1", status: "ARCHIVED" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([archivedDoc]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockDoc.update.mockResolvedValue({});
        mockSyncComments.mockResolvedValue({
      commentsCreated: 1, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: true, hasNonResolveActivity: true
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    const data = await readSSEResult(res);
    expect(data.unarchived).toBe(1);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { docId: "d1" },
      data: { status: "INBOX" },
    });
  });

  it("keeps archived doc archived when syncComments does not signal unarchive", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Archived Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    const archivedDoc = { docId: "d1", googleDocId: "g1", status: "ARCHIVED" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([archivedDoc]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    const data = await readSSEResult(res);
    expect(data.unarchived).toBe(0);
    // doc.update should NOT have been called to unarchive
    expect(mockDoc.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "INBOX" } })
    );
  });

  it("load mode only fetches selected docs by ID", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    // fetchDocsByIds returns only g1 (only selected doc)
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Selected Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"], // only g1 selected
    }));
    const data = await readSSEResult(res);
    expect(data.added).toBe(1);
    expect(mockFetchDocsByIds).toHaveBeenCalledWith("u1", ["g1"], expect.any(Function));
  });

  it("load mode returns 400 for invalid label IDs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    // User owns label l1 but not l2
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]);

    const res = await POST(postRequestWithBody("load", {
      labelIds: ["l1", "l2"],
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/label/i);
  });

  it("load mode applies labels and notes to new docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
      labelIds: ["l1"],
      notes: "Batch note",
    }));
    await readSSEResult(res);

    const upsertCall = mockDoc.upsert.mock.calls[0][0];
    expect(upsertCall.create.notes).toBe("Batch note");
    expect(upsertCall.create.labels).toEqual({
      create: [{ labelId: "l1" }],
    });
  });

  it("load mode applies status (ARCHIVED) to new docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
      status: "ARCHIVED",
    }));
    await readSSEResult(res);

    const upsertCall = mockDoc.upsert.mock.calls[0][0];
    expect(upsertCall.create.status).toBe("ARCHIVED");
  });

  it("load mode does not force-archive existing docs when status is ARCHIVED", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    // g1 already exists
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d1", notes: null });
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
      status: "ARCHIVED",
    }));
    await readSSEResult(res);

    const upsertCall = mockDoc.upsert.mock.calls[0][0];
    // ARCHIVED should not be applied to existing docs — only INBOX moves them
    expect(upsertCall.update.status).toBeUndefined();
  });

  it("load mode adds labels to existing docs via createMany skipDuplicates", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    // g1 already exists
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d1", notes: null });
    mockDocLabel.createMany.mockResolvedValue({ count: 1 });
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
      labelIds: ["l1"],
    }));
    await readSSEResult(res);
    expect(mockDocLabel.createMany).toHaveBeenCalledWith({
      data: [{ docId: "d1", labelId: "l1" }],
      skipDuplicates: true,
    });
  });

  it("load mode appends notes to existing docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Existing Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    // g1 already exists with existing notes
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d1", notes: "Existing note" });
    mockDoc.update.mockResolvedValue({});
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
      notes: "New note",
    }));
    await readSSEResult(res);
    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { docId: "d1" },
      data: { notes: "Existing note\nNew note" },
    });
  });

  it("load mode sets ARCHIVED for non-AUTHOR new docs (no loadStatus)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Some Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),

      },
    ]);

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    await readSSEResult(res);

    const upsertCall = mockDoc.upsert.mock.calls[0][0];
    expect(upsertCall.create.status).toBe("ARCHIVED");
  });

  it("does not unarchive when shouldUnarchive=true but hasNonResolveActivity=false", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockFetchDocsByIds.mockResolvedValue([
      {
        googleDocId: "g1",
        title: "Archived Doc",
        driveUrl: "https://docs.google.com/document/d/g1/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "AUTHOR" as const,
        lastModifiedInDrive: new Date("2024-06-01"),
        createdTimeInDrive: new Date("2024-05-01"),


      },
    ]);

    const archivedDoc = { docId: "d1", googleDocId: "g1", status: "ARCHIVED" };
    mockDoc.findMany
      .mockResolvedValueOnce([{ googleDocId: "g1" }]) // existingDocIds
      .mockResolvedValueOnce([archivedDoc]); // activeDocs for comment sync
    mockDoc.upsert.mockResolvedValue({ docId: "d-any" } as any);
    // shouldUnarchive is true but hasNonResolveActivity is false (resolve-only)
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: true, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: ["g1"],
    }));
    const data = await readSSEResult(res);
    expect(data.unarchived).toBe(0);
  });

  it("load mode with empty selection fetches no docs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    const driveAuth = {} as Awaited<ReturnType<typeof getDriveClient>>;
    mockGetDriveClient.mockResolvedValue(driveAuth);
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]);
    mockFetchDocsByIds.mockResolvedValue([]); // no docs fetched

    mockDoc.findMany
      .mockResolvedValueOnce([]) // existingDocIds
      .mockResolvedValueOnce([]); // commentDocs
    mockSyncComments.mockResolvedValue({
      commentsCreated: 0, commentsUpdated: 0,
      suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
      shouldUnarchive: false, hasNonResolveActivity: false
    });

    const res = await POST(postRequestWithBody("load", {
      source: "drive",
      selectedGoogleDocIds: [], // nothing selected
      labelIds: ["l1"],
      notes: "Should not be applied",
    }));
    const data = await readSSEResult(res);
    expect(data.added).toBe(0);
    expect(data.updated).toBe(0);
    expect(mockFetchDocsByIds).toHaveBeenCalledWith("u1", [], expect.any(Function));
    expect(mockDoc.upsert).not.toHaveBeenCalled();
  });
});

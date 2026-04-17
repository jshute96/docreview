import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

interface ScanResult {
  total: number;
  existingCount: number;
  errorCount?: number;
  docs: Array<{ googleDocId: string; title: string; role: string; isNew: boolean }>;
  noGmailAccount?: boolean;
}

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
  invalidGrantResponse: vi.fn(() => null),
  isInvalidGrantError: vi.fn(() => false),
}));
vi.mock("@/lib/gmail", () => ({
  scanGmailNotifications: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs } from "@/lib/google-drive";
import { scanGmailNotifications } from "@/lib/gmail";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findMany: ReturnType<typeof vi.fn>;
};
const mockListRecentDocs = vi.mocked(listRecentDocs);
const mockScanGmailNotifications = vi.mocked(scanGmailNotifications);

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

describe("POST /api/docs/scan", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(scanRequest());
    expect(res.status).toBe(401);
  });

  it("returns total, existingCount, and docs with isNew flag", async () => {
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


      },
      {
        googleDocId: "g2",
        title: "New Doc",
        driveUrl: "https://docs.google.com/document/d/g2/edit",
        mimeType: "application/vnd.google-apps.document",
        role: "REVIEWER" as const,
        lastModifiedInDrive: new Date(),
        createdTimeInDrive: new Date(),

      },
    ]);
    // g1 already in DB
    mockDoc.findMany.mockResolvedValue([{ googleDocId: "g1" }]);

    const res = await POST(scanRequest({ daysBack: 14 }));
    expect(res.status).toBe(200);
    const data = await readSSEResult<ScanResult>(res);
    expect(data.total).toBe(2);
    expect(data.existingCount).toBe(1);
    expect(data.docs).toHaveLength(2);
    // Existing doc
    expect(data.docs[0].googleDocId).toBe("g1");
    expect(data.docs[0].isNew).toBe(false);
    // New doc
    expect(data.docs[1].googleDocId).toBe("g2");
    expect(data.docs[1].title).toBe("New Doc");
    expect(data.docs[1].role).toBe("REVIEWER");
    expect(data.docs[1].isNew).toBe(true);
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
      expect.any(Function),
    );
  });

  it("returns error event when Drive API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findMany.mockResolvedValue([]);
    mockListRecentDocs.mockRejectedValue(new Error("Drive error"));

    await suppressingErrors(async () => {
      const res = await POST(scanRequest());
      expect(res.status).toBe(200); // SSE always returns 200 initially
      await expect(readSSEResult(res)).rejects.toThrow("Drive error");
    });
  });

  it("works with no request body", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockListRecentDocs.mockResolvedValue([]);
    mockDoc.findMany.mockResolvedValue([]);

    const res = await POST(scanRequest());
    expect(res.status).toBe(200);
    const data = await readSSEResult<ScanResult>(res);
    expect(data.total).toBe(0);
    expect(data.docs).toEqual([]);
  });

  it("Gmail scan returns docs with isNew flag", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockScanGmailNotifications.mockResolvedValue({
      docs: [
        {
          googleDocId: "g1",
          title: "Shared Doc",
          mimeType: "application/vnd.google-apps.document",
          driveUrl: "https://docs.google.com/document/d/g1/edit",
          role: "REVIEWER" as const,
        },
        {
          googleDocId: "g2",
          title: "Another Doc",
          mimeType: "application/vnd.google-apps.document",
          driveUrl: "https://docs.google.com/document/d/g2/edit",
          role: "REVIEWER" as const,
        },
      ],
      shareNotes: new Map(),
      inaccessibleDocs: [],
      errorCount: 1,
      skipCount: 0,
    });
    // g1 already tracked
    mockDoc.findMany.mockResolvedValue([{ googleDocId: "g1" }]);

    const res = await POST(scanRequest({ source: "gmail", daysBack: 7 }));
    expect(res.status).toBe(200);
    const data = await readSSEResult<ScanResult>(res);
    expect(data.total).toBe(2);
    expect(data.existingCount).toBe(1);
    expect(data.errorCount).toBe(1);
    expect(data.docs).toHaveLength(2);
    expect(data.docs[0].isNew).toBe(false);
    expect(data.docs[1].isNew).toBe(true);
    expect(mockListRecentDocs).not.toHaveBeenCalled();
  });

  it("Gmail scan returns empty when no notifications found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockScanGmailNotifications.mockResolvedValue({
      docs: [],
      shareNotes: new Map(),
      inaccessibleDocs: [],
      errorCount: 0,
      skipCount: 0,
    });
    mockDoc.findMany.mockResolvedValue([]);

    const res = await POST(scanRequest({ source: "gmail", daysBack: 30 }));
    const data = await readSSEResult<ScanResult>(res);
    expect(data.total).toBe(0);
    expect(data.docs).toEqual([]);
    expect(data.errorCount).toBe(0);
  });

  it("forwards noGmailAccount flag in scan result when account has no Gmail mailbox", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockScanGmailNotifications.mockResolvedValue({
      docs: [],
      shareNotes: new Map(),
      inaccessibleDocs: [],
      errorCount: 0,
      skipCount: 0,
      noGmailAccount: true,
    });
    mockDoc.findMany.mockResolvedValue([]);

    const res = await POST(scanRequest({ source: "gmail", daysBack: 7 }));
    const data = await readSSEResult<ScanResult>(res);
    expect(data.noGmailAccount).toBe(true);
    expect(data.total).toBe(0);
    expect(data.docs).toEqual([]);
  });

  it("returns error event when Gmail API fails", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findMany.mockResolvedValue([]);
    mockScanGmailNotifications.mockRejectedValue(new Error("Gmail error"));

    await suppressingErrors(async () => {
      const res = await POST(scanRequest({ source: "gmail", daysBack: 7 }));
      expect(res.status).toBe(200);
      await expect(readSSEResult(res)).rejects.toThrow("Gmail error");
    });
  });
});

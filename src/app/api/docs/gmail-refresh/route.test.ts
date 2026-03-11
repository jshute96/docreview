import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { getValidSession } from "@/lib/auth-utils";
import { scanGmailNotifications } from "@/lib/gmail";
import { fetchDocsByIds, getDriveClient } from "@/lib/google-drive";
import { handleMissingGmailDocs, insertInaccessibleDocs, upsertDocsAndSyncComments } from "@/lib/refresh";
import { getStatus, updateGmailTimestamp } from "@/lib/status";
import { prisma } from "@/lib/prisma";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/auth-utils");
vi.mock("@/lib/gmail");
vi.mock("@/lib/google-drive");
vi.mock("@/lib/refresh");
vi.mock("@/lib/status");
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock("@/lib/request-context", () => ({
  runWithRequestId: vi.fn((method, req, fn) => fn()),
}));

describe("Gmail Refresh API", () => {
  const userId = "u1";
  const userEmail = "test@example.com";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getValidSession).mockResolvedValue({ user: { id: userId, email: userEmail } } as any);
    vi.mocked(handleMissingGmailDocs).mockResolvedValue(0);
    vi.mocked(insertInaccessibleDocs).mockResolvedValue(0);
  });

  it("returns unauthorized if no session", async () => {
    vi.mocked(getValidSession).mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/docs/gmail-refresh", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("handles empty gmail results", async () => {
    vi.mocked(getStatus).mockResolvedValue({ lastGmailUpdateTimestamp: new Date() } as any);
    vi.mocked(scanGmailNotifications).mockResolvedValue({ docs: [], inaccessibleDocs: [], errorCount: 0, skipCount: 0, shareNotes: new Map() });

    const req = new NextRequest("http://localhost/api/docs/gmail-refresh", { method: "POST" });
    const res = await POST(req);
    const data = await res.json();

    expect(data.added).toBe(0);
    expect(vi.mocked(updateGmailTimestamp)).toHaveBeenCalled();
  });

  it("performs full sync flow", async () => {
    const gmailDoc = { googleDocId: "g1", threadId: "t1" };
    const driveDoc = { googleDocId: "g1", title: "Doc 1" };
    const syncRes = {
      added: 1,
      updated: 0,
      deleted: 0,
      unarchived: 0,
      commentsCreated: 2,
      commentsUpdated: 1,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      errorCount: 0,
      successCount: 1,
      totalAttempted: 1,
    };

    vi.mocked(getStatus).mockResolvedValue(null);
    vi.mocked(scanGmailNotifications).mockResolvedValue({ docs: [gmailDoc] as any, inaccessibleDocs: [], errorCount: 0, skipCount: 0, shareNotes: new Map() });
    vi.mocked(fetchDocsByIds).mockResolvedValue([driveDoc] as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(prisma.doc.findMany).mockResolvedValue([]); // existingDocIds query
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue(syncRes as any);

    const req = new NextRequest("http://localhost/api/docs/gmail-refresh", { method: "POST" });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.added).toBe(1);
    expect(data.comments).toBe(2);
    expect(vi.mocked(upsertDocsAndSyncComments)).toHaveBeenCalled();
    expect(vi.mocked(updateGmailTimestamp)).toHaveBeenCalled();
  });

  it("handles deletions detected via Gmail", async () => {
    const gmailDoc = { googleDocId: "g1", threadId: "t1" };
    const syncRes = {
      added: 0,
      updated: 0,
      deleted: 0,
      unarchived: 0,
      commentsCreated: 0,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      errorCount: 0,
      successCount: 0,
      totalAttempted: 0,
    };

    vi.mocked(getStatus).mockResolvedValue(null);
    vi.mocked(scanGmailNotifications).mockResolvedValue({ docs: [gmailDoc] as any, inaccessibleDocs: [], errorCount: 0, skipCount: 0, shareNotes: new Map() });
    vi.mocked(fetchDocsByIds).mockResolvedValue([]); // g1 missing from Drive
    vi.mocked(prisma.doc.findMany).mockResolvedValue([{ googleDocId: "g1" }] as any); // existingDocIds
    vi.mocked(handleMissingGmailDocs).mockResolvedValue(1);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue(syncRes as any);

    const req = new NextRequest("http://localhost/api/docs/gmail-refresh", { method: "POST" });
    const res = await POST(req);
    const data = await res.json();

    expect(data.deleted).toBe(1);
    expect(vi.mocked(handleMissingGmailDocs)).toHaveBeenCalled();
  });

  it("skips timestamp update on errors", async () => {
    vi.mocked(getStatus).mockResolvedValue(null);
    vi.mocked(scanGmailNotifications).mockResolvedValue({ docs: [], inaccessibleDocs: [], errorCount: 1, skipCount: 0, shareNotes: new Map() });

    const req = new NextRequest("http://localhost/api/docs/gmail-refresh", { method: "POST" });
    await POST(req);

    expect(vi.mocked(updateGmailTimestamp)).not.toHaveBeenCalled();
  });
});

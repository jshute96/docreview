import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService } from "@/lib/google-drive";
import { upsertDocsAndSyncComments } from "@/lib/refresh";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/auth-utils");
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock("@/lib/google-drive");
vi.mock("@/lib/refresh");
vi.mock("@/lib/request-context", () => ({
  runWithRequestId: vi.fn((method, req, fn) => fn()),
}));

describe("Single-doc Refresh API", () => {
  const userId = "u1";
  const docId = "d1";
  const googleDocId = "g1";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getValidSession).mockResolvedValue({ user: { id: userId, email: "test@example.com" } } as any);
  });

  function makeParams() {
    return { params: Promise.resolve({ docId }) };
  }

  it("returns 404 if doc not found", async () => {
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(null);
    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(404);
  });

  it("performs full sync flow", async () => {
    const dbDoc = { docId, userId, googleDocId };
    const driveDoc = { id: googleDocId, name: "Title", owners: [{ me: true }] };
    
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: {
        get: vi.fn().mockResolvedValue({ data: driveDoc }),
      },
    } as any);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue({} as any);

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);
    expect(vi.mocked(upsertDocsAndSyncComments)).toHaveBeenCalledWith(
      userId,
      "test@example.com",
      [expect.objectContaining({ googleDocId })],
      expect.objectContaining({ mode: "selected", docId })
    );
  });

  it("marks as deleted on 404 from Drive", async () => {
    const dbDoc = { docId, userId, googleDocId };
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: {
        get: vi.fn().mockRejectedValue({ code: 404 }),
      },
    } as any);

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    await POST(req, makeParams());

    expect(vi.mocked(prisma.doc.update)).toHaveBeenCalledWith(expect.objectContaining({
      where: { docId },
      data: { accessState: "NOT_FOUND" }
    }));
  });
});

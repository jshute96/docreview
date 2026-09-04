import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, fetchCommentData, fetchDocData } from "@/lib/google-drive";
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
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return {
    getDriveClient: vi.fn(),
    createDriveService: vi.fn(),
    fetchCommentData: vi.fn(),
    fetchDocData: vi.fn(),
    fetchFileTextViaExport: vi.fn(),
    invalidGrantResponse: vi.fn(() => null),
    driveUrlFor: actual.driveUrlFor,
    isDriveErrorCode: actual.isDriveErrorCode,
    getDriveErrorCode: actual.getDriveErrorCode,
    commentsAreHidden: actual.commentsAreHidden,
    COMMENT_VISIBILITY_FIELDS: actual.COMMENT_VISIBILITY_FIELDS,
  };
});
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
    // Default mocks for unified fetchers (called in parallel, feeding both sync and UI)
    vi.mocked(fetchCommentData).mockResolvedValue({ comments: [], threads: [] });
    vi.mocked(fetchDocData).mockResolvedValue({ documentText: null, suggestionContent: {}, suggestions: [] });
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

  it("reports comment access denial so the client can show it (and clear it)", async () => {
    const dbDoc = { docId, userId, googleDocId };
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: { get: vi.fn().mockResolvedValue({ data: { id: googleDocId, name: "Title", owners: [{ me: true }] } }) },
    } as any);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue({} as any);
    // With sync requested the 403 propagates rather than being swallowed.
    vi.mocked(fetchCommentData).mockRejectedValue(Object.assign(new Error("code 403"), { code: 403 }));

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);
    expect((await res.json()).forbidden).toBe(true);
  });

  it("clears the denial flag when comments come back", async () => {
    const dbDoc = { docId, userId, googleDocId };
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: { get: vi.fn().mockResolvedValue({ data: { id: googleDocId, name: "Title", owners: [{ me: true }] } }) },
    } as any);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue({} as any);

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect((await res.json()).forbidden).toBe(false);
  });

  it("reports comment access denial when Drive hides comments without a 403", async () => {
    // View-only access returns an empty comment list rather than a 403.
    const dbDoc = { docId, userId, googleDocId };
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: { get: vi.fn().mockResolvedValue({ data: { id: googleDocId, name: "Title", owners: [{ me: false }], capabilities: { canComment: false } } }) },
    } as any);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue({} as any);
    vi.mocked(fetchCommentData).mockResolvedValue({ comments: [], threads: [] });

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect((await res.json()).forbidden).toBe(true);
  });

  it("does not report denial when a no-comment-capability doc's threads are visible", async () => {
    const dbDoc = { docId, userId, googleDocId };
    vi.mocked(prisma.doc.findUnique).mockResolvedValue(dbDoc as any);
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(createDriveService).mockReturnValue({
      files: { get: vi.fn().mockResolvedValue({ data: { id: googleDocId, name: "Title", owners: [{ me: false }], capabilities: { canComment: false } } }) },
    } as any);
    vi.mocked(upsertDocsAndSyncComments).mockResolvedValue({} as any);
    vi.mocked(fetchCommentData).mockResolvedValue({
      comments: [],
      threads: [{ id: "c1", author: "A", fromMe: false, content: "x", createdTime: "", resolved: false, replies: [] }],
    } as any);

    const req = new NextRequest(`http://localhost/api/docs/${docId}/refresh`, { method: "POST" });
    const res = await POST(req, makeParams());
    expect((await res.json()).forbidden).toBe(false);
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

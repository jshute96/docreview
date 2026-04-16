import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DocRole, DocStatus } from "@prisma/client";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const doc = {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  return {
    prisma: {
      doc,
      label: {
        findMany: vi.fn(),
      },
      // $transaction receives an async callback — call it with a tx proxy that
      // delegates to the same mock so existing assertions on prisma.doc.create work.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ doc })),
    },
  };
});

vi.mock("@/lib/google-drive", () => ({
  getDriveClient: vi.fn(),
  createDriveService: vi.fn(() => ({
    files: {
      get: vi.fn().mockResolvedValue({
        data: {
          name: "Test Doc",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/test/edit",
          owners: [{ me: true, displayName: "Owner" }],
          trashed: false,
        },
      }),
    },
  })),
  parseGoogleDocId: vi.fn((url) => url.split("/").pop()),
  SUPPORTED_MIME_TYPES: new Set(["application/vnd.google-apps.document"]),
  invalidGrantResponse: vi.fn(() => null),
  driveUrlFor: vi.fn((fileId: string, webViewLink?: string | null) => webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`),
}));

vi.mock("@/lib/sync-comments", () => ({
  syncComments: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

describe("POST /api/docs/add", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function makeReq(body: unknown) {
    return new NextRequest("http://localhost/api/docs/add", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("adds a doc as INBOX by default", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValueOnce(null); // not existing
    mockDoc.create.mockResolvedValue({ docId: "d1" });
    mockDoc.findUnique.mockResolvedValueOnce({ docId: "d1", labels: [], comments: [] }); // result fetch

    const res = await POST(makeReq({ url: "https://docs.google.com/document/d/test" }));
    expect(res.status).toBe(201);
    
    expect(mockDoc.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "INBOX",
      }),
    }));
  });

  it("adds a doc as ARCHIVED when specified", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1" } });
    mockDoc.findUnique.mockResolvedValueOnce(null);
    mockDoc.create.mockResolvedValue({ docId: "d1" });
    mockDoc.findUnique.mockResolvedValueOnce({ docId: "d1", labels: [], comments: [] });

    const res = await POST(makeReq({ 
      url: "https://docs.google.com/document/d/test",
      status: "ARCHIVED"
    }));
    expect(res.status).toBe(201);
    
    expect(mockDoc.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ARCHIVED",
      }),
    }));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { doc: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return {
    ...actual,
    getDriveClient: vi.fn(),
    createDriveService: vi.fn(),
  };
});

import { GET } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createDriveService } from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockCreateDriveService = vi.mocked(createDriveService);

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcd";
const URL_FOR = `http://localhost/api/docs/validate?url=${encodeURIComponent(`https://docs.google.com/document/d/${FILE_ID}/edit`)}`;

function driveThatFailsWith(err: unknown) {
  mockCreateDriveService.mockReturnValue({
    files: { get: vi.fn().mockRejectedValue(err) },
  } as unknown as ReturnType<typeof createDriveService>);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1" } });
  mockDoc.findUnique.mockResolvedValue(null);
});

describe("GET /api/docs/validate", () => {
  it("allows adding a doc the user can't see (403)", async () => {
    driveThatFailsWith(Object.assign(new Error("no"), { code: 403 }));
    const res = await GET(new NextRequest(URL_FOR));
    expect(res.status).toBe(200);
    expect((await res.json()).permissionDenied).toBe(true);
  });

  it("allows adding a doc that isn't found (404)", async () => {
    driveThatFailsWith(Object.assign(new Error("gone"), { code: 404 }));
    const res = await GET(new NextRequest(URL_FOR));
    expect(res.status).toBe(200);
    expect((await res.json()).permissionDenied).toBe(true);
  });

  it("still works in offline mode, where there is no Drive at all", async () => {
    driveThatFailsWith(new OfflineModeError("offline"));
    const res = await GET(new NextRequest(URL_FOR));
    expect(res.status).toBe(200);
    expect((await res.json()).permissionDenied).toBe(true);
  });

  it("reports other Drive failures instead of previewing a placeholder doc", async () => {
    driveThatFailsWith(Object.assign(new Error("backend error"), { code: 500 }));
    await suppressingErrors(async () => {
      const res = await GET(new NextRequest(URL_FOR));
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("lookup_failed");
    });
  });
});

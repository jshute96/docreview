import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccessState, DocRole, DocStatus } from "@prisma/client";

// ---------- Mocks ----------

vi.mock("@/lib/prisma", () => {
  const doc = {
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const label = { findMany: vi.fn() };
  return {
    prisma: {
      doc,
      label,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ doc, label })),
    },
  };
});

vi.mock("@/lib/google-drive", () => ({
  getDriveClient: vi.fn(),
  createDriveService: vi.fn(),
  invalidGrantResponse: vi.fn(() => null),
  driveUrlFor: vi.fn((fileId: string, link?: string | null) => link ?? `https://docs.google.com/document/d/${fileId}/edit`),
  SUPPORTED_MIME_TYPES: new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.spreadsheet",
    "application/vnd.google-apps.presentation",
  ]),
}));

vi.mock("@/lib/sync-comments", () => ({
  syncComments: vi.fn(),
}));

vi.mock("@/lib/log", () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { addDoc, validateDocInputs, validateLabelOwnership } from "./add-doc";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";

const mockDoc = prisma.doc as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mockLabel = prisma.label as unknown as { findMany: ReturnType<typeof vi.fn> };
const mockGetDrive = vi.mocked(getDriveClient);
const mockCreateDriveService = vi.mocked(createDriveService);
const mockInvalidGrant = vi.mocked(invalidGrantResponse);
const mockSyncComments = vi.mocked(syncComments);

// ---------- Helpers ----------

const userId = "u1";
const googleDocId = "gdoc-abc";

function makeFallback(overrides: Partial<Parameters<typeof addDoc>[0]["fallback"]> = {}) {
  return {
    title: "Fallback Title",
    driveUrl: "https://docs.google.com/document/d/gdoc-abc/edit",
    mimeType: "application/vnd.google-apps.document",
    role: DocRole.REVIEWER,
    lastModifiedInDrive: null,
    createdTimeInDrive: null,
    ...overrides,
  };
}

function mockDriveFilesGet(data: Record<string, unknown>) {
  const filesGet = vi.fn().mockResolvedValue({ data });
  mockCreateDriveService.mockReturnValue({ files: { get: filesGet } } as unknown as ReturnType<typeof createDriveService>);
  return filesGet;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockInvalidGrant.mockReturnValue(null);
  mockDoc.findUnique.mockResolvedValue(null);
  mockDoc.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    docId: "new-doc-id",
    ...data,
  }));
  mockDoc.delete.mockResolvedValue({ docId: "old-doc-id" });
  mockLabel.findMany.mockResolvedValue([]);
  mockGetDrive.mockResolvedValue({} as Awaited<ReturnType<typeof getDriveClient>>);
  mockSyncComments.mockResolvedValue({
    commentsCreated: 0, commentsUpdated: 0,
    suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0,
    shouldUnarchive: false,
  });
});

// ---------- validateLabelOwnership ----------

describe("validateLabelOwnership", () => {
  it("returns null when labelIds is empty", async () => {
    const result = await validateLabelOwnership(userId, []);
    expect(result).toBeNull();
    expect(mockLabel.findMany).not.toHaveBeenCalled();
  });

  it("returns null when every labelId is owned", async () => {
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }, { labelId: "l2" }]);
    const result = await validateLabelOwnership(userId, ["l1", "l2"]);
    expect(result).toBeNull();
  });

  it("returns 400 response when a labelId is not owned", async () => {
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }]); // missing l2
    const res = await validateLabelOwnership(userId, ["l1", "l2"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid label" });
  });
});

// ---------- validateDocInputs ----------

describe("validateDocInputs", () => {
  it("accepts INBOX status", async () => {
    expect(await validateDocInputs({ userId, labelIds: [], status: DocStatus.INBOX })).toBeNull();
  });
  it("accepts ARCHIVED status", async () => {
    expect(await validateDocInputs({ userId, labelIds: [], status: DocStatus.ARCHIVED })).toBeNull();
  });
  it("accepts undefined status", async () => {
    expect(await validateDocInputs({ userId, labelIds: [] })).toBeNull();
  });

  it("rejects invalid status", async () => {
    const res = await validateDocInputs({ userId, labelIds: [], status: "BOGUS" });
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid status" });
  });

  it("rejects non-boolean isStarred", async () => {
    const res = await validateDocInputs({
      userId, labelIds: [], isStarred: "yes" as unknown as boolean,
    });
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid isStarred" });
  });

  it("delegates label ownership check", async () => {
    mockLabel.findMany.mockResolvedValue([]); // requesting "l1" is not owned
    const res = await validateDocInputs({ userId, labelIds: ["l1"] });
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid label" });
  });
});

// ---------- addDoc ----------

describe("addDoc", () => {
  it("creates a new doc with Drive metadata when Drive succeeds (owner → AUTHOR)", async () => {
    const filesGet = mockDriveFilesGet({
      name: "Real Title",
      mimeType: "application/vnd.google-apps.document",
      webViewLink: "https://docs.google.com/document/d/gdoc-abc/edit?x=1",
      modifiedTime: "2026-03-20T12:00:00.000Z",
      createdTime: "2026-01-01T00:00:00.000Z",
      owners: [{ me: true, displayName: "Me" }],
      trashed: false,
    });
    mockDoc.findUnique.mockResolvedValue({
      docId: "new-doc-id",
      title: "Real Title",
      labels: [],
      comments: [],
    });

    const res = await addDoc({
      userId,
      googleDocId,
      labelIds: [],
      fallback: makeFallback(),
    });

    expect(res.status).toBe(201);
    expect(filesGet).toHaveBeenCalledWith(expect.objectContaining({ fileId: googleDocId, supportsAllDrives: true }));
    const createArgs = mockDoc.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      userId,
      googleDocId,
      title: "Real Title",
      mimeType: "application/vnd.google-apps.document",
      role: DocRole.AUTHOR,
      accessState: AccessState.OK,
      status: DocStatus.INBOX,
      driveUrl: "https://docs.google.com/document/d/gdoc-abc/edit?x=1",
      lastModifiedInDrive: new Date("2026-03-20T12:00:00.000Z"),
      createdTimeInDrive: new Date("2026-01-01T00:00:00.000Z"),
      lastCommentActivity: new Date("2026-01-01T00:00:00.000Z"),
      isStarred: false,
      notes: null,
    });
    expect(mockSyncComments).toHaveBeenCalled();
  });

  it("sets role=REVIEWER when current user is not an owner", async () => {
    mockDriveFilesGet({
      name: "Shared Doc",
      mimeType: "application/vnd.google-apps.document",
      webViewLink: null,
      owners: [{ me: false, displayName: "Other" }],
      trashed: false,
    });

    await addDoc({
      userId,
      googleDocId,
      labelIds: [],
      fallback: makeFallback(),
    });

    expect(mockDoc.create.mock.calls[0][0].data.role).toBe(DocRole.REVIEWER);
  });

  it("uses provided status, notes, isStarred and labels", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [{ me: true }], trashed: false,
    });
    mockLabel.findMany.mockResolvedValue([{ labelId: "l1" }, { labelId: "l2" }]);

    await addDoc({
      userId,
      googleDocId,
      labelIds: ["l1", "l2"],
      isStarred: true,
      notes: "hello",
      status: DocStatus.ARCHIVED,
      fallback: makeFallback(),
    });

    const data = mockDoc.create.mock.calls[0][0].data;
    expect(data.status).toBe(DocStatus.ARCHIVED);
    expect(data.isStarred).toBe(true);
    expect(data.notes).toBe("hello");
    expect(data.labels.create).toEqual([{ labelId: "l1" }, { labelId: "l2" }]);
  });

  it("normalizes empty-string notes to null", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [{ me: true }], trashed: false,
    });
    await addDoc({
      userId, googleDocId, labelIds: [],
      notes: "",
      fallback: makeFallback(),
    });
    expect(mockDoc.create.mock.calls[0][0].data.notes).toBeNull();
  });

  it("rejects trashed docs with 400 and does not create", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [], trashed: true,
    });

    const res = await addDoc({
      userId, googleDocId, labelIds: [],
      fallback: makeFallback(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "trashed" });
    expect(mockDoc.create).not.toHaveBeenCalled();
    expect(mockSyncComments).not.toHaveBeenCalled();
  });

  it("rejects unsupported mime types with 400", async () => {
    mockDriveFilesGet({
      name: "T",
      mimeType: "application/pdf",
      owners: [], trashed: false,
    });

    const res = await addDoc({
      userId, googleDocId, labelIds: [],
      fallback: makeFallback(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_mime_type" });
    expect(mockDoc.create).not.toHaveBeenCalled();
  });

  it("falls back to DENIED record when Drive API rejects access", async () => {
    mockCreateDriveService.mockReturnValue({
      files: {
        get: vi.fn().mockRejectedValue(Object.assign(new Error("Not allowed"), { status: 403 })),
      },
    } as unknown as ReturnType<typeof createDriveService>);
    mockDoc.findUnique.mockResolvedValue({ docId: "new-doc-id", title: "", labels: [], comments: [] });

    const fallback = makeFallback({
      title: "From Gmail",
      role: DocRole.REVIEWER,
      lastModifiedInDrive: new Date("2026-02-02"),
      createdTimeInDrive: new Date("2026-01-01"),
    });

    const res = await addDoc({
      userId, googleDocId, labelIds: [],
      fallback,
    });

    expect(res.status).toBe(201);
    const data = mockDoc.create.mock.calls[0][0].data;
    expect(data.accessState).toBe(AccessState.DENIED);
    expect(data.title).toBe("From Gmail");
    expect(data.role).toBe(DocRole.REVIEWER);
    expect(data.lastModifiedInDrive).toEqual(new Date("2026-02-02"));
    // No comment sync when permission denied
    expect(mockSyncComments).not.toHaveBeenCalled();
  });

  it("returns early with the reauth response when Drive token is invalid", async () => {
    const { NextResponse } = await import("next/server");
    const reauth = NextResponse.json({ error: "reauth" }, { status: 401 });
    mockCreateDriveService.mockReturnValue({
      files: { get: vi.fn().mockRejectedValue(new Error("invalid_grant")) },
    } as unknown as ReturnType<typeof createDriveService>);
    mockInvalidGrant.mockReturnValue(reauth);

    const res = await addDoc({
      userId, googleDocId, labelIds: [],
      fallback: makeFallback(),
    });

    expect(res).toBe(reauth);
    expect(mockDoc.create).not.toHaveBeenCalled();
    expect(mockSyncComments).not.toHaveBeenCalled();
  });

  it("deletes an old doc inside the transaction when deleteDocId is set (re-add)", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [{ me: true }], trashed: false,
    });

    await addDoc({
      userId, googleDocId, labelIds: [],
      deleteDocId: "old-doc-id",
      fallback: makeFallback(),
    });

    expect(mockDoc.delete).toHaveBeenCalledWith({ where: { docId: "old-doc-id" } });
    expect(mockDoc.create).toHaveBeenCalled();
  });

  it("does not call tx.delete when deleteDocId is not set", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [{ me: true }], trashed: false,
    });

    await addDoc({
      userId, googleDocId, labelIds: [],
      fallback: makeFallback(),
    });

    expect(mockDoc.delete).not.toHaveBeenCalled();
  });

  it("rejects when a requested label is not owned by user", async () => {
    mockLabel.findMany.mockResolvedValue([]); // "l1" missing
    const res = await addDoc({
      userId, googleDocId, labelIds: ["l1"],
      fallback: makeFallback(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid label" });
    expect(mockDoc.create).not.toHaveBeenCalled();
  });

  it("initializes lastCommentActivity from createdTimeInDrive", async () => {
    mockDriveFilesGet({
      name: "T", mimeType: "application/vnd.google-apps.document",
      owners: [{ me: true }], trashed: false,
      createdTime: "2026-03-01T00:00:00.000Z",
    });
    await addDoc({ userId, googleDocId, labelIds: [], fallback: makeFallback() });
    const data = mockDoc.create.mock.calls[0][0].data;
    expect(data.lastCommentActivity).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });
});

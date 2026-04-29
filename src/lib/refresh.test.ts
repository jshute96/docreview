import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertDocsAndSyncComments, executeRefresh } from "./refresh";
import { prisma } from "./prisma";
import { getDriveClient } from "./google-drive";
import { syncComments } from "./sync-comments";
import { scanGmailForDocIds } from "./gmail";
import { getStatus, updateGmailTimestamp, updateDriveChangesToken } from "./status";

vi.mock("./prisma");
vi.mock("./google-drive");
vi.mock("./sync-comments");
vi.mock("./log");
vi.mock("./gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gmail")>();
  return {
    ...actual,
    scanGmailForDocIds: vi.fn(),
    buildInaccessibleDocs: vi.fn(() => []),
  };
});
vi.mock("./status", () => ({
  getStatus: vi.fn(),
  updateGmailTimestamp: vi.fn(),
  updateDriveChangesToken: vi.fn(),
}));

describe("upsertDocsAndSyncComments", () => {
  const userId = "u1";
  const userEmail = "test@example.com";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(syncComments).mockResolvedValue({
      commentsCreated: 0,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive: false,
    });
  });

  it("sets status to ARCHIVED for a new authored doc during refresh (avoiding noise)", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "http://g1",
        mimeType: "doc",
        role: "AUTHOR",
        lastModifiedInDrive: new Date(),

        createdTimeInDrive: new Date(),
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(),
      mode: "refresh",
    });

    expect(prisma.doc.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          googleDocId: "g1",
          status: "ARCHIVED", // Should be ARCHIVED even if AUTHOR
        }),
      })
    );
  });

  it("creates Gmail-discovered docs as ARCHIVED; promotion to INBOX comes from share-note or shouldUnarchive paths", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "http://g1",
        mimeType: "doc",
        role: "AUTHOR",
        lastModifiedInDrive: new Date(),

        createdTimeInDrive: new Date(),
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(),
      fromGmailDocIdSet: new Set(["g1"]),
      mode: "refresh",
    });

    expect(prisma.doc.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          googleDocId: "g1",
          status: "ARCHIVED",
        }),
      })
    );
    // No share note and no shouldUnarchive → stays ARCHIVED.
    expect(prisma.doc.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "INBOX" }) }),
    );
  });

  it("promotes a new Gmail-discovered doc to INBOX when a share note is present", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "Shared Doc",
        driveUrl: "http://g1",
        mimeType: "doc",
        role: "REVIEWER",
        lastModifiedInDrive: new Date(),
        createdTimeInDrive: new Date(),
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
      notes: "Shared by Alice",
    } as any);

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(),
      fromGmailDocIdSet: new Set(["g1"]),
      shareNotes: new Map([["g1", "Shared by Alice"]]),
      mode: "refresh",
    });

    // Share-note branch should promote ARCHIVED → INBOX for the new doc too.
    expect(prisma.doc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docId: "d1" },
        data: expect.objectContaining({ status: "INBOX" }),
      }),
    );
  });

  it("promotes a new Gmail-discovered doc to INBOX when shouldUnarchive is set by comment sync", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "Mentioned Doc",
        driveUrl: "http://g1",
        mimeType: "doc",
        role: "AUTHOR",
        lastModifiedInDrive: new Date(),
        createdTimeInDrive: new Date(),
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    vi.mocked(syncComments).mockResolvedValue({
      commentsCreated: 1,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive: true,
    });

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(),
      fromGmailDocIdSet: new Set(["g1"]),
      mode: "refresh",
    });

    expect(prisma.doc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docId: "d1" },
        data: { status: "INBOX" },
      }),
    );
  });

  it("unarchives an ARCHIVED doc if syncComments returns shouldUnarchive", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "Active Doc",
        role: "AUTHOR",
      },
    ];

    // Doc starts as ARCHIVED
    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    // Activity detected
    vi.mocked(syncComments).mockResolvedValue({
      commentsCreated: 1,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive: true,
    });

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(["g1"]),
      mode: "refresh",
    });

    // Verify it was updated to INBOX
    expect(prisma.doc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docId: "d1" },
        data: { status: "INBOX" },
      })
    );
  });

  it("skips unarchive when lastCommentActivity is older than unarchiveCutoff", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "Stale Doc",
        role: "AUTHOR",
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    // Activity detected by sync
    vi.mocked(syncComments).mockResolvedValue({
      commentsCreated: 1,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive: true,
    });

    // Last comment activity is 30 days ago
    vi.mocked(prisma.doc.findUnique).mockResolvedValue({
      lastCommentActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    } as any);

    // Cutoff is 7 days ago
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(["g1"]),
      mode: "refresh",
      unarchiveCutoff: cutoff,
    });

    // Should NOT have updated to INBOX
    expect(prisma.doc.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "INBOX" },
      })
    );
  });

  it("does NOT advance lastGmailUpdateTimestamp when account has no Gmail mailbox", async () => {
    vi.mocked(getStatus).mockResolvedValue(undefined as any);
    vi.mocked(scanGmailForDocIds).mockResolvedValue({
      docIds: [],
      shareNotes: new Map(),
      emailMeta: new Map(),
      errorCount: 0,
      noGmailAccount: true,
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
    vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);

    const result = await executeRefresh(userId, userEmail, { gmail: true });

    expect(result.noGmailAccount).toBe(true);
    expect(updateGmailTimestamp).not.toHaveBeenCalled();
  });

  it("advances lastGmailUpdateTimestamp on a normal Gmail scan with no docs", async () => {
    vi.mocked(getStatus).mockResolvedValue(undefined as any);
    vi.mocked(scanGmailForDocIds).mockResolvedValue({
      docIds: [],
      shareNotes: new Map(),
      emailMeta: new Map(),
      errorCount: 0,
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
    vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);

    const result = await executeRefresh(userId, userEmail, { gmail: true });

    expect(result.noGmailAccount).toBeUndefined();
    expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
  });

  it("still unarchives when lastCommentActivity is newer than unarchiveCutoff", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "Active Doc",
        role: "AUTHOR",
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "ARCHIVED",
    } as any);

    vi.mocked(syncComments).mockResolvedValue({
      commentsCreated: 1,
      commentsUpdated: 0,
      suggestionsCreated: 0,
      suggestionsUpdated: 0,
      suggestionsResolved: 0,
      shouldUnarchive: true,
    });

    // Last comment activity is 1 hour ago — recent
    vi.mocked(prisma.doc.findUnique).mockResolvedValue({
      lastCommentActivity: new Date(Date.now() - 60 * 60 * 1000),
    } as any);

    // Cutoff is 7 days ago
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(["g1"]),
      mode: "refresh",
      unarchiveCutoff: cutoff,
    });

    // Should have updated to INBOX
    expect(prisma.doc.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { docId: "d1" },
        data: { status: "INBOX" },
      })
    );
  });
});

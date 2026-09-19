import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertDocsAndSyncComments, executeRefresh, insertInaccessibleDocs } from "./refresh";
import { prisma } from "./prisma";
import { fetchDocsByIds, findDeletedOrDeniedDocIds, getDriveClient, listChanges } from "./google-drive";
import { bumpLastCommentActivity, syncComments } from "./sync-comments";
import { buildInaccessibleDocs, scanGmailForDocIds } from "./gmail";
import { getStatus, updateDriveChangesToken, updateGmailTimestamp } from "./status";

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

  it("appends a new share note to an existing archived doc, unarchives, and bumps activity", async () => {
    const driveDocs = [{ googleDocId: "g1", driveUrl: "http://g1", mimeType: "doc", role: "REVIEWER", lastModifiedInDrive: new Date(), createdTimeInDrive: new Date() }];
    vi.mocked(prisma.doc.upsert).mockResolvedValue({ docId: "d1", googleDocId: "g1", status: "ARCHIVED", notes: "Old note" } as any);
    const shareDate = new Date("2026-03-01T00:00:00Z");

    const res = await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(["g1"]),
      fromGmailDocIdSet: new Set(["g1"]),
      shareNotes: new Map([["g1", "Shared by Alice"]]),
      shareDates: new Map([["g1", shareDate]]),
      mode: "refresh",
    });

    expect(prisma.doc.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { docId: "d1" }, data: { notes: "Old note\nShared by Alice", status: "INBOX" } }),
    );
    expect(bumpLastCommentActivity).toHaveBeenCalledWith("d1", [shareDate]);
    expect(res.unarchived).toBe(1);
  });

  it("does not re-unarchive or bump when the share note is already present", async () => {
    const driveDocs = [{ googleDocId: "g1", driveUrl: "http://g1", mimeType: "doc", role: "REVIEWER", lastModifiedInDrive: new Date(), createdTimeInDrive: new Date() }];
    vi.mocked(prisma.doc.upsert).mockResolvedValue({ docId: "d1", googleDocId: "g1", status: "ARCHIVED", notes: "Shared by Alice" } as any);

    const res = await upsertDocsAndSyncComments(userId, userEmail, driveDocs as any, {
      existingDocIds: new Set(["g1"]),
      fromGmailDocIdSet: new Set(["g1"]),
      shareNotes: new Map([["g1", "Shared by Alice"]]),
      mode: "refresh",
    });

    expect(prisma.doc.update).not.toHaveBeenCalled();
    expect(bumpLastCommentActivity).not.toHaveBeenCalled();
    expect(res.unarchived).toBe(0);
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
      shareDates: new Map(),
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
      shareDates: new Map(),
      emailMeta: new Map(),
      errorCount: 0,
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
    vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);

    const result = await executeRefresh(userId, userEmail, { gmail: true });

    expect(result.noGmailAccount).toBeUndefined();
    expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
  });

  describe("cursor advancement (issue #24)", () => {
    const driveDoc = { googleDocId: "g1", driveUrl: "http://g1", mimeType: "doc", role: "AUTHOR", lastModifiedInDrive: new Date(), createdTimeInDrive: new Date() };
    const transientResult = { commentsCreated: 0, commentsUpdated: 0, suggestionsCreated: 0, suggestionsUpdated: 0, suggestionsResolved: 0, shouldUnarchive: false, transientError: true };

    beforeEach(() => {
      vi.mocked(getStatus).mockResolvedValue({ userId, driveChangesPageToken: "old-token", lastGmailUpdateTimestamp: new Date(0) } as any);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
      vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.doc.upsert).mockResolvedValue({ docId: "d1", googleDocId: "g1", status: "INBOX" } as any);
      vi.mocked(listChanges).mockResolvedValue({
        docs: [driveDoc], rawChangeCount: 1, trashedDocIds: new Set(), removedDocIds: new Set(), newPageToken: "new-token",
      } as any);
      vi.mocked(scanGmailForDocIds).mockResolvedValue({
        docIds: [], shareNotes: new Map(), shareDates: new Map(), emailMeta: new Map(), errorCount: 0,
      });
    });

    it("advances both cursors even when a doc's comment sync has a transient error", async () => {
      // Two docs: one fails transiently, one succeeds → not allFailed.
      vi.mocked(listChanges).mockResolvedValue({
        docs: [driveDoc, { ...driveDoc, googleDocId: "g2" }], rawChangeCount: 2, trashedDocIds: new Set(), removedDocIds: new Set(), newPageToken: "new-token",
      } as any);
      vi.mocked(syncComments).mockResolvedValueOnce(transientResult as any);

      const result = await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      expect(result.errorCount).toBe(1);
      expect(updateDriveChangesToken).toHaveBeenCalledWith(userId, "new-token");
      expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
    });

    it("keeps both cursors when every doc sync fails (allFailed)", async () => {
      vi.mocked(syncComments).mockResolvedValue(transientResult as any);

      await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      expect(updateDriveChangesToken).not.toHaveBeenCalled();
      expect(updateGmailTimestamp).not.toHaveBeenCalled();
    });

    it("does not treat a permission-denied (403) doc as a failure for allFailed", async () => {
      vi.mocked(syncComments).mockResolvedValue({ ...transientResult, transientError: undefined, permissionDenied: true } as any);

      await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      expect(updateDriveChangesToken).toHaveBeenCalledWith(userId, "new-token");
      expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
    });

    const gmailScanWith = (ids: string[]) => ({
      docIds: ids, shareNotes: new Map(), shareDates: new Map(),
      emailMeta: new Map(ids.map(id => [id, [{ headers: new Map(), textBody: "", htmlBody: "" }]])), errorCount: 0,
    });

    it("holds the Gmail timestamp and inserts nothing when a NEW Gmail-only doc's metadata fetch fails transiently", async () => {
      vi.mocked(scanGmailForDocIds).mockResolvedValue(gmailScanWith(["gmail-1"]));
      vi.mocked(fetchDocsByIds).mockResolvedValue({ docs: [], transientErrorIds: ["gmail-1"] });

      const result = await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      // Not treated as inaccessible (would have been inserted as NOT_FOUND before).
      expect(buildInaccessibleDocs).not.toHaveBeenCalled();
      expect(result.errorCount).toBe(1);
      // Drive side is fine; Gmail must re-scan the notification so the doc gets created.
      expect(updateDriveChangesToken).toHaveBeenCalledWith(userId, "new-token");
      expect(updateGmailTimestamp).not.toHaveBeenCalled();
    });

    it("does not deletion-check or hold the Gmail timestamp for an EXISTING Gmail-only doc that fails transiently", async () => {
      vi.mocked(scanGmailForDocIds).mockResolvedValue(gmailScanWith(["gmail-1"]));
      vi.mocked(fetchDocsByIds).mockResolvedValue({ docs: [], transientErrorIds: ["gmail-1"] });
      vi.mocked(prisma.doc.findMany).mockResolvedValue([{ docId: "d1", googleDocId: "gmail-1", status: "INBOX" }] as any);
      vi.mocked(findDeletedOrDeniedDocIds).mockResolvedValue({ trashedIds: new Set(), deletedIds: new Set(), permissionDeniedIds: new Set() });

      const result = await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      // Unknown state ≠ missing: must not be marked deleted/denied.
      expect(findDeletedOrDeniedDocIds).not.toHaveBeenCalled();
      expect(result.errorCount).toBe(1);
      // Already tracked, so nothing is lost by advancing; metadata catches up later.
      expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
    });

    it("does not hold the Gmail timestamp for a stale-only doc that fails transiently", async () => {
      // Stale catch-up query returns a doc that Gmail didn't mention.
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ google_doc_id: "stale-1", title: "", comments_last_synced_at: null }] as any);
      vi.mocked(fetchDocsByIds).mockResolvedValue({ docs: [], transientErrorIds: ["stale-1"] });

      const result = await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      expect(result.errorCount).toBe(1);
      // Retried by the stale query next time regardless, so both cursors advance.
      expect(updateDriveChangesToken).toHaveBeenCalledWith(userId, "new-token");
      expect(updateGmailTimestamp).toHaveBeenCalledTimes(1);
    });

    it("keeps the Gmail timestamp but advances the Drive token when the Gmail scan had errors", async () => {
      vi.mocked(scanGmailForDocIds).mockResolvedValue({
        docIds: [], shareNotes: new Map(), shareDates: new Map(), emailMeta: new Map(), errorCount: 2,
      });

      await executeRefresh(userId, userEmail, { drive: true, gmail: true });

      expect(updateDriveChangesToken).toHaveBeenCalledWith(userId, "new-token");
      expect(updateGmailTimestamp).not.toHaveBeenCalled();
    });
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

describe("executeDirectRefresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getDriveClient).mockResolvedValue({} as any);
    vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);
    vi.mocked(findDeletedOrDeniedDocIds).mockResolvedValue({ trashedIds: new Set(), deletedIds: new Set(), permissionDeniedIds: new Set() });
  });

  it("does not check transiently-failed docs for deletion and counts them as errors", async () => {
    vi.mocked(fetchDocsByIds).mockResolvedValue({ docs: [], transientErrorIds: ["g-transient"] });

    const result = await executeRefresh("u1", "test@example.com", { googleDocIds: ["g-transient", "g-missing"], mode: "selected" });

    expect(findDeletedOrDeniedDocIds).toHaveBeenCalledWith("u1", ["g-missing"]);
    expect(result.errorCount).toBe(1);
  });
});

describe("insertInaccessibleDocs", () => {
  it("propagates DB errors instead of swallowing them (so the refresh aborts before cursors advance)", async () => {
    vi.mocked(prisma.doc.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("db down"));

    await expect(insertInaccessibleDocs("u1", [
      { googleDocId: "g1", title: "t", accessState: "DENIED", notes: null, emailDate: new Date() } as any,
    ])).rejects.toThrow("db down");
  });
});

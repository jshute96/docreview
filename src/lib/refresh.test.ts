import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertDocsAndSyncComments } from "./refresh";
import { prisma } from "./prisma";
import { getDriveClient } from "./google-drive";
import { syncComments } from "./sync-comments";

vi.mock("./prisma");
vi.mock("./google-drive");
vi.mock("./sync-comments");
vi.mock("./log");

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
      hasNonResolveActivity: false,
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
        owner: "Me",
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

  it("sets status to INBOX if discovered via Gmail", async () => {
    const driveDocs = [
      {
        googleDocId: "g1",
        title: "New Doc",
        driveUrl: "http://g1",
        mimeType: "doc",
        role: "AUTHOR",
        lastModifiedInDrive: new Date(),
        owner: "Me",
        createdTimeInDrive: new Date(),
      },
    ];

    vi.mocked(prisma.doc.upsert).mockResolvedValue({
      docId: "d1",
      googleDocId: "g1",
      status: "INBOX",
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
          status: "INBOX", // Gmail discovery takes precedence
        }),
      })
    );
  });

  it("unarchives an ARCHIVED doc if syncComments returns shouldUnarchive and hasNonResolveActivity", async () => {
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
      hasNonResolveActivity: true,
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
});

import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  listChanges,
  listRecentDocs,
  getChangesStartPageToken,
  fetchDocsByIds,
  findDeletedDocIds,
  type DriveDoc,
} from "@/lib/google-drive";
import { scanGmailForDocIds } from "@/lib/gmail";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateDriveChangesToken, updateGmailTimestamp } from "@/lib/status";
import { logError, logWarning, logInfo } from "@/lib/log";
import { formatDate } from "@/lib/utils";

export type RefreshSource = "drive" | "gmail";

export interface RefreshResult {
  added: number;
  updated: number;
  deleted: number;
  unarchived: number;
  comments: number;
  errorCount: number;
}

const DEFAULT_GMAIL_DAYS_BACK = 7;

export async function executeRefresh(
  userId: string,
  userEmail: string | undefined,
  sources: RefreshSource[]
): Promise<RefreshResult> {
  const t0 = Date.now();
  const includeDrive = sources.includes("drive");
  const includeGmail = sources.includes("gmail");
  logInfo(`[Refresh] Starting refresh (sources: ${sources.join(", ")})`);

  // Shared setup
  const driveAuth = await getDriveClient(userId);
  const status = await getStatus(userId);

  // --- Discovery phase (parallel) ---
  let driveDocs: DriveDoc[] = [];
  let deletedDocIds = new Set<string>();
  let newPageToken: string | undefined;
  let driveSucceeded = false;

  let gmailDocIds: string[] = [];
  let gmailErrorCount = 0;
  let gmailSucceeded = false;

  const discoveryPromises: Promise<void>[] = [];

  if (includeDrive) {
    discoveryPromises.push((async () => {
      const savedToken = status?.driveChangesPageToken;
      if (savedToken) {
        logInfo("[Refresh] Drive: using changes.list with saved token");
        try {
          const result = await listChanges(userId, savedToken);
          driveDocs = result.docs;
          deletedDocIds = result.deletedDocIds;
          newPageToken = result.newPageToken;
          logInfo(`[Refresh] Drive: ${driveDocs.length} changed docs, ${deletedDocIds.size} deletions`);
          driveSucceeded = true;
        } catch (err: unknown) {
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            logWarning("[Refresh] Drive: changes.list token expired, falling back to 7-day files.list");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId);
            driveSucceeded = true;
          } else {
            throw err;
          }
        }
      } else {
        logInfo("[Refresh] Drive: no saved token, bootstrapping (7-day files.list)");
        newPageToken = await getChangesStartPageToken(userId);
        driveDocs = await listRecentDocs(userId);
        driveSucceeded = true;
      }
    })());
  }

  if (includeGmail) {
    discoveryPromises.push((async () => {
      const since = status?.lastGmailUpdateTimestamp
        ?? new Date(Date.now() - DEFAULT_GMAIL_DAYS_BACK * 24 * 60 * 60 * 1000);
      logInfo(`[Refresh] Gmail: scanning since ${formatDate(since)}`);
      const result = await scanGmailForDocIds(userId, since);
      gmailDocIds = result.docIds;
      gmailErrorCount = result.errorCount;
      gmailSucceeded = true;
      logInfo(`[Refresh] Gmail: ${gmailDocIds.length} doc IDs (${gmailErrorCount} errors)`);
    })());
  }

  // Run discovery in parallel — allSettled ensures both errors are logged if both fail
  const discoveryResults = await Promise.allSettled(discoveryPromises);
  for (const result of discoveryResults) {
    if (result.status === "rejected") {
      logError("[Refresh] Discovery phase error:", result.reason);
      throw result.reason;
    }
  }

  // --- Merge + single metadata fetch ---
  const driveDocMap = new Map(driveDocs.map((d) => [d.googleDocId, d]));
  const gmailOnlyIds = gmailDocIds.filter((id) => !driveDocMap.has(id));

  let gmailOnlyDocs: DriveDoc[] = [];
  if (gmailOnlyIds.length > 0) {
    logInfo(`[Refresh] Fetching Drive metadata for ${gmailOnlyIds.length} Gmail-only docs`);
    gmailOnlyDocs = await fetchDocsByIds(userId, gmailOnlyIds);
  }

  const allDocs = [...driveDocs, ...gmailOnlyDocs];
  const gmailDocIdSet = new Set(gmailDocIds);

  const driveCount = driveDocs.length;
  const gmailCount = gmailDocIds.length;
  const bothCount = gmailDocIds.filter((id) => driveDocMap.has(id)).length;
  logInfo(`[Refresh] Combined: ${allDocs.length} unique docs (${driveCount} from Drive, ${gmailCount} from Gmail, ${bothCount} in both)`);

  // --- Pre-fetch existing doc IDs ---
  const existingDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId },
      select: { googleDocId: true },
    })).map((d) => d.googleDocId)
  );

  // --- Upsert loop ---
  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const doc of allDocs) {
    const isExisting = existingDocIds.has(doc.googleDocId);
    const fromGmail = gmailDocIdSet.has(doc.googleDocId);

    // Drive-only new non-AUTHOR docs: skip (shared docs arrive via Gmail)
    if (!fromGmail && !isExisting && doc.role !== "AUTHOR") {
      logInfo(`[Refresh]   SKIP "${doc.title}" — new ${doc.role} doc (Drive-only, not AUTHOR)`);
      continue;
    }

    await prisma.doc.upsert({
      where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
      create: {
        userId,
        googleDocId: doc.googleDocId,
        title: doc.title,
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        role: doc.role,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        owner: doc.owner,
        createdTimeInDrive: doc.createdTimeInDrive,
        // Gmail docs always start as INBOX; Drive-only use role-based default
        status: fromGmail ? "INBOX" : (doc.role === "AUTHOR" ? "INBOX" : "ARCHIVED"),
      },
      update: {
        title: doc.title,
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        owner: doc.owner,
        createdTimeInDrive: doc.createdTimeInDrive,
        isDeleted: false,
      },
    });

    if (isExisting) {
      logInfo(`[Refresh]   UPDATE "${doc.title}"`);
      updated++;
    } else {
      logInfo(`[Refresh]   ADD "${doc.title}" — ${doc.role} (owner: ${doc.owner ?? "unknown"})${fromGmail ? " [Gmail]" : ""}`);
      added++;
    }
  }

  // --- Deletions ---
  // From Drive changes.list
  if (deletedDocIds.size > 0) {
    logInfo(`[Refresh] Processing ${deletedDocIds.size} deletions from Drive changes.list`);
    const docsToDelete = await prisma.doc.findMany({
      where: {
        userId,
        isDeleted: false,
        googleDocId: { in: [...deletedDocIds] },
      },
      select: { docId: true },
    });
    for (const doc of docsToDelete) {
      await prisma.doc.update({ where: { docId: doc.docId }, data: { isDeleted: true } });
      deleted++;
    }
  }

  // Gmail docs that failed fetchDocsByIds (returned null) — check if tracked and deleted
  if (gmailOnlyIds.length > 0) {
    const returnedGmailIds = new Set(gmailOnlyDocs.map((d) => d.googleDocId));
    const missingIds = gmailOnlyIds.filter((id) => !returnedGmailIds.has(id) && existingDocIds.has(id));
    if (missingIds.length > 0) {
      logInfo(`[Refresh] Checking ${missingIds.length} missing Gmail docs for deletion`);
      const deletedIds = await findDeletedDocIds(userId, missingIds);
      for (const id of deletedIds) {
        await prisma.doc.updateMany({
          where: { userId, googleDocId: id },
          data: { isDeleted: true },
        });
        deleted++;
      }
    }
  }

  // --- Comment sync ---
  const allDocIds = new Set(allDocs.map((d) => d.googleDocId));
  const commentDocs = await prisma.doc.findMany({
    where: { userId, isDeleted: false, googleDocId: { in: [...allDocIds] } },
  });
  logInfo(`[Refresh] Syncing comments for ${commentDocs.length} docs`);
  const syncResults = await Promise.all(
    commentDocs.map((doc) => syncComments(doc, driveAuth, userEmail))
  );
  const comments = syncResults.reduce((sum, r) => sum + r.created, 0);

  // --- Unarchive + deletion from sync ---
  let unarchived = 0;
  for (let i = 0; i < commentDocs.length; i++) {
    const res = syncResults[i];
    if (res.isDeleted) {
      await prisma.doc.update({ where: { docId: commentDocs[i].docId }, data: { isDeleted: true } });
      deleted++;
      continue;
    }
    if (commentDocs[i].status === "ARCHIVED" && res.shouldUnarchive && res.hasNonResolveActivity) {
      await prisma.doc.update({ where: { docId: commentDocs[i].docId }, data: { status: "INBOX" } });
      unarchived++;
    }
  }

  // --- Save tokens ---
  const anyTransientError = syncResults.some((r) => r.transientError);

  if (driveSucceeded && newPageToken && !anyTransientError) {
    logInfo("[Refresh] Saving Drive changes token");
    await updateDriveChangesToken(userId, newPageToken);
  } else if (driveSucceeded && newPageToken && anyTransientError) {
    logWarning("[Refresh] Transient errors during comment sync, skipping Drive token update");
  }

  if (gmailSucceeded) {
    await updateGmailTimestamp(userId, new Date());
  }

  const elapsed = Date.now() - t0;
  const errorCount = gmailErrorCount;
  logInfo(`[Refresh] Complete in ${elapsed}ms: ${added} added, ${updated} updated, ${deleted} deleted, ${unarchived} unarchived, ${comments} comments (${errorCount} errors)`);
  return { added, updated, deleted, unarchived, comments, errorCount };
}

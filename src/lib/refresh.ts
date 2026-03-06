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
import { logError, logWarning, logInfo, logToFile } from "@/lib/log";
import { formatDate, pluralize } from "@/lib/utils";
import type { Doc } from "@prisma/client";

const DEBUG_FILE = "drive-changes-debug.log";

export type RefreshSource = "drive" | "gmail";

export interface RefreshResult {
  added: number;
  updated: number;
  deleted: number;
  unarchived: number;
  commentsCreated: number;
  commentsUpdated: number;
  suggestionsCreated: number;
  suggestionsUpdated: number;
  errorCount: number;
  skipNotAuthor?: number;
  // Extra stats for safety checks
  successCount?: number;
  totalAttempted?: number;
}

const DEFAULT_GMAIL_DAYS_BACK = 7;

/**
 * Shared logic to update a set of documents from Drive metadata and sync their comments.
 * Supports multiple modes:
 * - refresh/full-refresh: auto-adds AUTHOR docs, sets INBOX status for relevant activity
 * - load: manual selection, sets ARCHIVED status for non-AUTHOR docs
 * - selected: targeted refresh of specific existing docs
 * Returns counts of added, updated, deleted, unarchived, and comment threads synced.
 */
export async function upsertDocsAndSyncComments(
  userId: string,
  userEmail: string | undefined,
  driveDocs: DriveDoc[],
  options: {
    existingDocIds: Set<string>;
    fromGmailDocIdSet?: Set<string>;
    mode?: "refresh" | "full-refresh" | "selected" | "load";
    docId?: string; // Optional: restrict upsert to a specific docId (for single-doc refresh)
  }
): Promise<RefreshResult> {
  const { existingDocIds, fromGmailDocIdSet = new Set(), mode = "refresh", docId } = options;
  const driveAuth = await getDriveClient(userId);

  let added = 0;
  let updated = 0;
  let deleted = 0;
  let skipNotAuthor = 0;

  const processedDocs: Doc[] = [];

  for (const doc of driveDocs) {
    if (!doc || !doc.googleDocId) continue;
    const isExisting = existingDocIds.has(doc.googleDocId);
    const fromGmail = fromGmailDocIdSet.has(doc.googleDocId);

    // Refresh/full-refresh: auto-add new docs I authored; skip others.
    // Shared docs arrive via Gmail notifications instead.
    if ((mode === "refresh" || mode === "full-refresh") && !isExisting && !fromGmail && doc.role !== "AUTHOR") {
      logToFile(DEBUG_FILE, `OUTCOME: SKIP: "${doc.title}" (ID: ${doc.googleDocId}) — new REVIEWER doc (not in Gmail)`);
      skipNotAuthor++;
      continue;
    }

    const result = await prisma.doc.upsert({
      where: docId
        ? { docId }
        : { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
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
        // Mode-based status defaults:
        // - load: ARCHIVED unless I authored it
        // - refresh/full-refresh/Gmail: INBOX if from Gmail or I authored it; else ARCHIVED
        status: (mode === "load")
          ? (doc.role === "AUTHOR" ? "INBOX" : "ARCHIVED")
          : (fromGmail || doc.role === "AUTHOR" ? "INBOX" : "ARCHIVED"),
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

    processedDocs.push(result);

    if (isExisting) {
      if (mode !== "selected") {
        logInfo(`[Refresh]   UPDATE "${doc.title}"`);
      }
      logToFile(DEBUG_FILE, `OUTCOME: UPDATE: "${doc.title}" (ID: ${doc.googleDocId})`);
      updated++;
    } else {
      logInfo(`[Refresh]   ADD "${doc.title}" — ${doc.role} (owner: ${doc.owner ?? "unknown"})${fromGmail ? " [Gmail]" : ""}`);
      logToFile(DEBUG_FILE, `OUTCOME: ADD: "${doc.title}" (ID: ${doc.googleDocId}) — ${doc.role}${fromGmail ? " [Gmail]" : ""}`);
      added++;
    }
  }

  // Sync comments for all docs we just upserted
  logInfo(`[Refresh] Syncing comments for ${processedDocs.length} docs`);
  const syncResults = await Promise.all(
    processedDocs.map((doc) => syncComments(doc, driveAuth, userEmail))
  );
  const commentsCreated = syncResults.reduce((sum, r) => sum + r.commentsCreated, 0);
  const commentsUpdated = syncResults.reduce((sum, r) => sum + r.commentsUpdated, 0);
  const suggestionsCreated = syncResults.reduce((sum, r) => sum + r.suggestionsCreated, 0);
  const suggestionsUpdated = syncResults.reduce((sum, r) => sum + r.suggestionsUpdated, 0);

  let unarchived = 0;
  for (let i = 0; i < processedDocs.length; i++) {
    const res = syncResults[i];
    if (res.isDeleted) {
      await prisma.doc.update({ where: { docId: processedDocs[i].docId }, data: { isDeleted: true } });
      deleted++;
      continue;
    }
    if (processedDocs[i].status === "ARCHIVED" && res.shouldUnarchive && res.hasNonResolveActivity) {
      await prisma.doc.update({ where: { docId: processedDocs[i].docId }, data: { status: "INBOX" } });
      unarchived++;
    }
  }

  const errorCount = syncResults.filter(r => r.transientError).length;
  const permissionErrorCount = syncResults.filter(r => r.permissionDenied).length;
  const syncDeletedCount = syncResults.filter(r => r.isDeleted).length;
  const successCount = syncResults.length - errorCount - permissionErrorCount - syncDeletedCount;

  return {
    added,
    updated,
    deleted,
    unarchived,
    commentsCreated,
    commentsUpdated,
    suggestionsCreated,
    suggestionsUpdated,
    errorCount,
    successCount,
    totalAttempted: processedDocs.length,
    skipNotAuthor
  };
}

/**
 * Common logic to refresh a specific set of Google Doc IDs.
 * Used by Refresh Selected and Full Refresh.
 */
async function refreshGoogleDocIds(
  userId: string,
  userEmail: string | undefined,
  googleDocIds: string[],
  mode: "selected" | "full-refresh"
): Promise<RefreshResult> {
  const t0 = Date.now();
  if (googleDocIds.length === 0) {
    logInfo(`[Refresh] No docs to refresh (${mode})`);
    return {
      added: 0, updated: 0, deleted: 0, unarchived: 0,
      commentsCreated: 0, commentsUpdated: 0, suggestionsCreated: 0, suggestionsUpdated: 0,
      errorCount: 0
    };
  }

  logInfo(`[Refresh] Refreshing ${googleDocIds.length} docs (${mode})`);
  logToFile(DEBUG_FILE, "-------------------------------------");
  logToFile(DEBUG_FILE, `Starting exhaustive refresh (${mode}) for ${googleDocIds.length} IDs`);

  // Exhaustive metadata fetch for these specific IDs
  const driveDocs = (await fetchDocsByIds(userId, googleDocIds)) || [];

  const dbDocs = await prisma.doc.findMany({
    where: { userId },
    select: { googleDocId: true }
  });
  const existingDocIds = new Set(dbDocs.map(d => d.googleDocId));

  const syncRes = await upsertDocsAndSyncComments(
    userId,
    userEmail,
    driveDocs,
    { existingDocIds, mode }
  );

  // Deletion detection: if fetchDocsByIds missed some docs, check if they are actually deleted
  const foundIds = new Set(driveDocs.map(d => d.googleDocId));
  const missingIds = googleDocIds.filter(id => !foundIds.has(id));

  let additionalDeleted = 0;
  if (missingIds.length > 0) {
    logToFile(DEBUG_FILE, `Checking ${missingIds.length} docs missing from Drive metadata fetch`);
    const deletedIds = await findDeletedDocIds(userId, missingIds);
    if (deletedIds) {
      for (const id of missingIds) {
        if (deletedIds.has(id)) {
          logToFile(DEBUG_FILE, `OUTCOME: DELETE (MISSING): ID: ${id}`);
          await prisma.doc.updateMany({
            where: { userId, googleDocId: id },
            data: { isDeleted: true },
          });
          additionalDeleted++;
        }
      }
    }
  }

  const elapsed = Date.now() - t0;
  const result = { ...syncRes, deleted: syncRes.deleted + additionalDeleted };
  const counts = [
    pluralize(result.updated, "doc") + " updated",
    pluralize(result.deleted, "doc") + " deleted",
    pluralize(result.unarchived, "doc") + " unarchived",
  ];
  const commentStr = `${pluralize(result.commentsCreated, "new comment thread")}, ${pluralize(result.commentsUpdated, "updated comment thread")}`;
  const suggestionStr = result.suggestionsCreated > 0 || result.suggestionsUpdated > 0
    ? `, ${pluralize(result.suggestionsCreated, "new suggestion")}, ${pluralize(result.suggestionsUpdated, "updated suggestion")}`
    : "";
  const skipStr = result.skipNotAuthor && result.skipNotAuthor > 0
    ? `, ${pluralize(result.skipNotAuthor, "doc")} skipped (not author)`
    : "";
  logInfo(`[Refresh] ${mode} complete in ${elapsed}ms: ${counts.join(", ")}, ${commentStr}${suggestionStr}${skipStr} (${pluralize(result.errorCount, "error")})`);
  logToFile(DEBUG_FILE, `Ended exhaustive refresh (${mode}): ${result.updated} updated, ${result.deleted} deleted`);
  return result;
}

/**
 * Handles Gmail docs that were not returned by fetchDocsByIds.
 * Checks if they were deleted/access revoked in Drive.
 */
export async function handleMissingGmailDocs(
  userId: string,
  gmailDocIds: string[],
  returnedDocIds: Set<string>,
  existingDocIds: Set<string>
): Promise<number> {
  const missingIds = gmailDocIds.filter((id) => !returnedDocIds.has(id) && existingDocIds.has(id));
  let extraDeleted = 0;
  if (missingIds.length > 0) {
    logInfo(`[Refresh] Checking ${missingIds.length} missing Gmail docs for deletion`);
    const deletedIds = await findDeletedDocIds(userId, missingIds);
    for (const id of missingIds) {
      if (deletedIds.has(id)) {
        logToFile(DEBUG_FILE, `OUTCOME: DELETE (GMAIL MISSING): ID: ${id}`);
        await prisma.doc.updateMany({
          where: { userId, googleDocId: id },
          data: { isDeleted: true },
        });
        extraDeleted++;
      }
    }
  }
  return extraDeleted;
}

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
  const status = await getStatus(userId);

  // --- Discovery phase (parallel) ---
  let driveDocs: DriveDoc[] = [];
  let deletedDocIdsFromDrive = new Set<string>();
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
        logToFile(DEBUG_FILE, "-------------------------------------");
        logToFile(DEBUG_FILE, "Starting changes.list sync");
        try {
          const result = await listChanges(userId, savedToken);
          driveDocs = result.docs;
          deletedDocIdsFromDrive = result.deletedDocIds;
          newPageToken = result.newPageToken;
          driveSucceeded = true;
          logToFile(DEBUG_FILE, `Ended changes.list sync: ${driveDocs.length} changed docs, ${deletedDocIdsFromDrive.size} total deletions reported by Drive`);
        } catch (err: unknown) {
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            logWarning("[Refresh] Drive: changes.list token expired, falling back to 7-day files.list");
            logToFile(DEBUG_FILE, "Token expired, falling back to files.list");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId);
            driveSucceeded = true;
            logToFile(DEBUG_FILE, `Ended files.list sync (fallback): ${driveDocs.length} docs`);
          } else {
            logToFile(DEBUG_FILE, "Ended changes.list sync with error", { error: err });
            throw err;
          }
        }
      } else {
        logInfo("[Refresh] Drive: no saved token, bootstrapping (7-day files.list)");
        logToFile(DEBUG_FILE, "-------------------------------------");
        logToFile(DEBUG_FILE, "Starting files.list sync (bootstrap)");
        newPageToken = await getChangesStartPageToken(userId);
        driveDocs = await listRecentDocs(userId);
        driveSucceeded = true;
        logToFile(DEBUG_FILE, `Ended files.list sync (bootstrap): ${driveDocs.length} docs`);
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

  await Promise.all(discoveryPromises);

  // --- Merge + single metadata fetch ---
  const driveDocMap = new Map(driveDocs.map((d) => [d.googleDocId, d]));
  const gmailOnlyIds = gmailDocIds.filter((id) => !driveDocMap.has(id));

  let gmailOnlyDocs: DriveDoc[] = [];
  if (gmailOnlyIds.length > 0) {
    logInfo(`[Refresh] Fetching Drive metadata for ${gmailOnlyIds.length} Gmail-only docs`);
    gmailOnlyDocs = await fetchDocsByIds(userId, gmailOnlyIds);
  }

  const allDiscoveryDocs = [...driveDocs, ...gmailOnlyDocs];
  const gmailDocIdSet = new Set(gmailDocIds);

  const existingDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId },
      select: { googleDocId: true },
    })).map((d) => d.googleDocId)
  );

  const syncRes = await upsertDocsAndSyncComments(
    userId,
    userEmail,
    allDiscoveryDocs,
    { existingDocIds, fromGmailDocIdSet: gmailDocIdSet, mode: "refresh" }
  );

  let extraDeleted = 0;
  // Handle deletions from Drive changes.list
  if (deletedDocIdsFromDrive.size > 0) {
    const docsToDelete = await prisma.doc.findMany({
      where: {
        userId,
        isDeleted: false,
        googleDocId: { in: [...deletedDocIdsFromDrive] },
      },
      select: { docId: true, googleDocId: true, title: true },
    });
    logInfo(`[Refresh] Drive: ${docsToDelete.length} of ${deletedDocIdsFromDrive.size} deletions were tracked docs`);
    for (const doc of docsToDelete) {
      logToFile(DEBUG_FILE, `OUTCOME: DELETE: "${doc.title}" (ID: ${doc.googleDocId})`);
      await prisma.doc.update({ where: { docId: doc.docId }, data: { isDeleted: true } });
      extraDeleted++;
    }
  }

  // Gmail docs that failed fetchDocsByIds — check if tracked and deleted
  if (gmailOnlyIds.length > 0) {
    const returnedGmailIds = new Set(gmailOnlyDocs.map((d) => d.googleDocId));
    extraDeleted += await handleMissingGmailDocs(userId, gmailOnlyIds, returnedGmailIds, existingDocIds);
  }

  // Save tokens - only if not all failed (safety check)
  const allFailed = (syncRes.totalAttempted ?? 0) > 0 && (syncRes.successCount ?? 0) === 0;

  if (driveSucceeded && newPageToken && syncRes.errorCount === 0 && !allFailed) {
    await updateDriveChangesToken(userId, newPageToken);
  } else if (driveSucceeded && newPageToken && allFailed) {
    logWarning(`[Refresh] All document syncs failed, skipping Drive token update for safety`);
  }

  if (gmailSucceeded && syncRes.errorCount === 0 && !allFailed && gmailErrorCount === 0) {
    await updateGmailTimestamp(userId, new Date());
  }

  const elapsed = Date.now() - t0;
  const totalErrorCount = gmailErrorCount + syncRes.errorCount;
  const totalDeleted = syncRes.deleted + extraDeleted;
  const counts = [
    pluralize(syncRes.added, "doc") + " added",
    pluralize(syncRes.updated, "doc") + " updated",
    pluralize(totalDeleted, "doc") + " deleted",
    pluralize(syncRes.unarchived, "doc") + " unarchived",
  ];
  const commentStr = `${pluralize(syncRes.commentsCreated, "new comment thread")}, ${pluralize(syncRes.commentsUpdated, "updated comment thread")}`;
  const suggestionStr = syncRes.suggestionsCreated > 0 || syncRes.suggestionsUpdated > 0
    ? `, ${pluralize(syncRes.suggestionsCreated, "new suggestion")}, ${pluralize(syncRes.suggestionsUpdated, "updated suggestion")}`
    : "";
  const skipStr = syncRes.skipNotAuthor && syncRes.skipNotAuthor > 0
    ? `, ${pluralize(syncRes.skipNotAuthor, "doc")} skipped (not author)`
    : "";
  logInfo(`[Refresh] Complete in ${elapsed}ms: ${counts.join(", ")}, ${commentStr}${suggestionStr}${skipStr} (${pluralize(totalErrorCount, "error")})`);
  return { ...syncRes, deleted: totalDeleted, errorCount: totalErrorCount };
}

export async function refreshSelectedDocs(
  userId: string,
  userEmail: string | undefined,
  docIds: string[]
): Promise<RefreshResult> {
  const docs = await prisma.doc.findMany({
    where: { userId, docId: { in: docIds } },
    select: { googleDocId: true }
  });
  const googleDocIds = docs.map(d => d.googleDocId);
  return refreshGoogleDocIds(userId, userEmail, googleDocIds, "selected");
}

export async function executeFullRefresh(
  userId: string,
  userEmail: string | undefined
): Promise<RefreshResult> {
  const docs = await prisma.doc.findMany({
    where: { userId, isDeleted: false },
    select: { googleDocId: true }
  });
  const googleDocIds = docs.map(d => d.googleDocId);
  return refreshGoogleDocIds(userId, userEmail, googleDocIds, "full-refresh");
}

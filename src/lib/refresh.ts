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
import { appendNotes, formatDate, pluralize } from "@/lib/utils";
import type { OnProgress } from "@/lib/progress-events";
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
  driveChangesRead?: number;
  totalDocuments?: number;
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
    shareNotes?: Map<string, string>;
    mode?: "refresh" | "full-refresh" | "selected" | "load";
    docId?: string; // Optional: restrict upsert to a specific docId (for single-doc refresh)
  },
  onProgress?: OnProgress,
): Promise<RefreshResult> {
  const { existingDocIds, fromGmailDocIdSet = new Set(), shareNotes, mode = "refresh", docId } = options;
  const driveAuth = await getDriveClient(userId);

  let added = 0;
  let updated = 0;
  let deleted = 0;
  let unarchived = 0;
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
        notes: shareNotes?.get(doc.googleDocId) ?? null,
        // Mode-based status defaults:
        // All new docs discovered via Drive activity start as ARCHIVED to avoid noise
        // from old docs resurfacing. We rely on Gmail notifications or the
        // subsequent comment sync (Phase 3) to move them to INBOX if relevant.
        status: fromGmail ? "INBOX" : "ARCHIVED",
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

    // Append share note and unarchive existing docs discovered via Gmail.
    // parseShareNote() returns a note for ALL share emails (even without a custom
    // message), so this fires for every share — not just ones with a message attached.
    // A (re)share is a strong signal the doc needs attention, so we always unarchive.
    const shareNote = shareNotes?.get(doc.googleDocId);
    if (isExisting && shareNote) {
      const newNotes = appendNotes(result.notes, shareNote);
      const unarchive = result.status === "ARCHIVED";
      await prisma.doc.update({
        where: { docId: result.docId },
        data: { notes: newNotes, ...(unarchive ? { status: "INBOX" } : {}) },
      });
      result.notes = newNotes;
      if (unarchive) {
        result.status = "INBOX";
        unarchived++;
      }
    }

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
  let syncCompleted = 0;
  let lastProgressTime = 0;
  const syncTotal = processedDocs.length;
  onProgress?.({ phase: "sync", completed: 0, total: syncTotal });
  const syncResults = await Promise.all(
    processedDocs.map(async (doc) => {
      const result = await syncComments(doc, driveAuth, userEmail);
      syncCompleted++;
      const now = Date.now();
      if (syncCompleted === syncTotal || now - lastProgressTime >= 500) {
        lastProgressTime = now;
        onProgress?.({ phase: "sync", completed: syncCompleted, total: syncTotal });
      }
      return result;
    })
  );
  const commentsCreated = syncResults.reduce((sum, r) => sum + r.commentsCreated, 0);
  const commentsUpdated = syncResults.reduce((sum, r) => sum + r.commentsUpdated, 0);
  const suggestionsCreated = syncResults.reduce((sum, r) => sum + r.suggestionsCreated, 0);
  const suggestionsUpdated = syncResults.reduce((sum, r) => sum + r.suggestionsUpdated, 0);

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
 * Given a list of Google Doc IDs that were expected but not returned by a
 * Drive metadata fetch, check whether they are actually deleted/trashed and
 * mark them accordingly in the database.  Returns the number of docs marked.
 */
async function markMissingAsDeleted(
  userId: string,
  missingIds: string[],
  logLabel: string,
): Promise<number> {
  if (missingIds.length === 0) return 0;
  logInfo(`[Refresh] Checking ${missingIds.length} missing ${logLabel} docs for deletion`);
  const deletedIds = await findDeletedDocIds(userId, missingIds);
  let count = 0;
  for (const id of missingIds) {
    if (deletedIds.has(id)) {
      logToFile(DEBUG_FILE, `OUTCOME: DELETE (${logLabel.toUpperCase()} MISSING): ID: ${id}`);
      await prisma.doc.updateMany({
        where: { userId, googleDocId: id },
        data: { isDeleted: true },
      });
      count++;
    }
  }
  return count;
}

/**
 * Common logic to refresh a specific set of Google Doc IDs.
 * Used by Refresh Selected and Full Refresh.
 */
async function refreshGoogleDocIds(
  userId: string,
  userEmail: string | undefined,
  googleDocIds: string[],
  mode: "selected" | "full-refresh",
  onProgress?: OnProgress,
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
  onProgress?.({ phase: "metadata", completed: 0, total: googleDocIds.length });
  const driveDocs = (await fetchDocsByIds(userId, googleDocIds, (count) => {
    onProgress?.({ phase: "metadata", completed: count, total: googleDocIds.length });
  })) || [];

  const dbDocs = await prisma.doc.findMany({
    where: { userId },
    select: { googleDocId: true }
  });
  const existingDocIds = new Set(dbDocs.map(d => d.googleDocId));

  const syncRes = await upsertDocsAndSyncComments(
    userId,
    userEmail,
    driveDocs,
    { existingDocIds, mode },
    onProgress,
  );

  // Deletion detection: if fetchDocsByIds missed some docs, check if they are actually deleted
  const foundIds = new Set(driveDocs.map(d => d.googleDocId));
  const missingIds = googleDocIds.filter(id => !foundIds.has(id));
  const additionalDeleted = await markMissingAsDeleted(userId, missingIds, mode);

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
  return markMissingAsDeleted(userId, missingIds, "Gmail");
}

export async function executeRefresh(
  userId: string,
  userEmail: string | undefined,
  sources: RefreshSource[],
  onProgress?: OnProgress,
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
  let gmailShareNotes = new Map<string, string>();
  let gmailErrorCount = 0;
  let gmailSucceeded = false;

  let staleGoogleDocIds: string[] = [];

  const discoveryPromises: Promise<void>[] = [];

  // Catch-up: find docs with stale comments (never synced, or synced before
  // last Drive modification). Runs in parallel with Drive/Gmail discovery.
  discoveryPromises.push((async () => {
    const rows = await prisma.$queryRaw<{ google_doc_id: string; title: string; comments_last_synced_at: Date | null }[]>`
      SELECT google_doc_id, title, comments_last_synced_at FROM docs
      WHERE user_id = ${userId}
        AND is_deleted = false
        AND (
          comments_last_synced_at IS NULL
          OR (last_modified_in_drive IS NOT NULL AND comments_last_synced_at < last_modified_in_drive)
        )
    `;
    staleGoogleDocIds = rows.map(r => r.google_doc_id);
    if (rows.length > 0) {
      logInfo(`[Refresh] Found ${rows.length} docs with stale comments to catch up`);
      for (const r of rows) {
        const reason = r.comments_last_synced_at === null ? "never synced" : "synced before last modification";
        logInfo(`[Refresh]   STALE "${r.title}" (${r.google_doc_id}) — ${reason}`);
      }
    }
  })());

  let driveChangesRead = 0;

  if (includeDrive) {
    discoveryPromises.push((async () => {
      onProgress?.({ phase: "drive", status: "reading", count: 0 });
      const savedToken = status?.driveChangesPageToken;
      if (savedToken) {
        logInfo("[Refresh] Drive: using changes.list with saved token");
        logToFile(DEBUG_FILE, "-------------------------------------");
        logToFile(DEBUG_FILE, "Starting changes.list sync");
        try {
          const result = await listChanges(userId, savedToken, (stats) => {
            onProgress?.({ phase: "drive", status: "reading", ...stats });
          });
          driveDocs = result.docs;
          driveChangesRead = result.rawChangeCount;
          deletedDocIdsFromDrive = result.deletedDocIds;
          newPageToken = result.newPageToken;
          driveSucceeded = true;
          logToFile(DEBUG_FILE, `Ended changes.list sync: ${driveDocs.length} changed docs, ${deletedDocIdsFromDrive.size} total deletions reported by Drive`);
          onProgress?.({ phase: "drive", status: "done", count: driveDocs.length, totalChanges: result.rawChangeCount });
        } catch (err: unknown) {
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            logWarning("[Refresh] Drive: changes.list token expired, falling back to 7-day files.list");
            logToFile(DEBUG_FILE, "Token expired, falling back to files.list");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId, undefined, undefined, (stats) => {
              onProgress?.({ phase: "drive", status: "reading", ...stats });
            });
            driveChangesRead = driveDocs.length;
            driveSucceeded = true;
            logToFile(DEBUG_FILE, `Ended files.list sync (fallback): ${driveDocs.length} docs`);
            onProgress?.({ phase: "drive", status: "done", count: driveDocs.length, totalChanges: driveDocs.length });
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
        driveDocs = await listRecentDocs(userId, undefined, undefined, (stats) => {
          onProgress?.({ phase: "drive", status: "reading", ...stats });
        });
        driveChangesRead = driveDocs.length;
        driveSucceeded = true;
        logToFile(DEBUG_FILE, `Ended files.list sync (bootstrap): ${driveDocs.length} docs`);
        onProgress?.({ phase: "drive", status: "done", count: driveDocs.length, totalChanges: driveDocs.length });
      }
    })());
  }

  if (includeGmail) {
    discoveryPromises.push((async () => {
      onProgress?.({ phase: "gmail", status: "reading", count: 0 });
      const since = status?.lastGmailUpdateTimestamp
        ?? new Date(Date.now() - DEFAULT_GMAIL_DAYS_BACK * 24 * 60 * 60 * 1000);
      logInfo(`[Refresh] Gmail: scanning since ${formatDate(since)}`);
      const result = await scanGmailForDocIds(userId, since, (count, total) => {
        onProgress?.({ phase: "gmail", status: "reading", count, total });
      });
      gmailDocIds = result.docIds;
      gmailShareNotes = result.shareNotes;
      gmailErrorCount = result.errorCount;
      gmailSucceeded = true;
      logInfo(`[Refresh] Gmail: ${gmailDocIds.length} doc IDs (${gmailErrorCount} errors)`);
      onProgress?.({ phase: "gmail", status: "done", count: gmailDocIds.length, errorCount: gmailErrorCount });
    })());
  }

  await Promise.all(discoveryPromises);

  // --- Merge + single metadata fetch ---
  const driveDocMap = new Map(driveDocs.map((d) => [d.googleDocId, d]));
  const gmailOnlyIds = gmailDocIds.filter((id) => !driveDocMap.has(id));

  // Stale docs not already covered by Drive or Gmail discovery
  const coveredIds = new Set([...driveDocMap.keys(), ...gmailDocIds]);
  const staleOnlyIds = staleGoogleDocIds.filter((id) => !coveredIds.has(id));

  // Fetch metadata for Gmail-only and stale-only docs in one batch
  const extraIds = [...gmailOnlyIds, ...staleOnlyIds];
  let extraDocs: DriveDoc[] = [];
  if (extraIds.length > 0) {
    const staleSuffix = staleOnlyIds.length > 0 ? `, ${staleOnlyIds.length} stale catch-up` : "";
    logInfo(`[Refresh] Fetching Drive metadata for ${extraIds.length} extra docs (${gmailOnlyIds.length} Gmail-only${staleSuffix})`);
    onProgress?.({ phase: "metadata", completed: 0, total: extraIds.length });
    extraDocs = await fetchDocsByIds(userId, extraIds, (count) => {
      onProgress?.({ phase: "metadata", completed: count, total: extraIds.length });
    });
  }

  const allDiscoveryDocs = [...driveDocs, ...extraDocs];
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
    { existingDocIds, fromGmailDocIdSet: gmailDocIdSet, shareNotes: gmailShareNotes, mode: "refresh" },
    onProgress,
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
    const returnedExtraIds = new Set(extraDocs.map((d) => d.googleDocId));
    extraDeleted += await handleMissingGmailDocs(userId, gmailOnlyIds, returnedExtraIds, existingDocIds);
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
  const driveStr = driveChangesRead > 0 ? `${pluralize(driveChangesRead, "Drive change")} processed, ` : "";
  logInfo(`[Refresh] Complete in ${elapsed}ms: ${driveStr}${counts.join(", ")}, ${commentStr}${suggestionStr}${skipStr} (${pluralize(totalErrorCount, "error")})`);
  return { ...syncRes, deleted: totalDeleted, errorCount: totalErrorCount, driveChangesRead, totalDocuments: allDiscoveryDocs.length };
}

export async function refreshSelectedDocs(
  userId: string,
  userEmail: string | undefined,
  docIds: string[],
  onProgress?: OnProgress,
): Promise<RefreshResult> {
  const docs = await prisma.doc.findMany({
    where: { userId, docId: { in: docIds } },
    select: { googleDocId: true }
  });
  const googleDocIds = docs.map(d => d.googleDocId);
  return refreshGoogleDocIds(userId, userEmail, googleDocIds, "selected", onProgress);
}

export async function executeFullRefresh(
  userId: string,
  userEmail: string | undefined,
  onProgress?: OnProgress,
): Promise<RefreshResult> {
  const docs = await prisma.doc.findMany({
    where: { userId, isDeleted: false },
    select: { googleDocId: true }
  });
  const googleDocIds = docs.map(d => d.googleDocId);
  return refreshGoogleDocIds(userId, userEmail, googleDocIds, "full-refresh", onProgress);
}

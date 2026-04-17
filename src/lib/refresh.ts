import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  listChanges,
  listRecentDocs,
  getChangesStartPageToken,
  fetchDocsByIds,
  findDeletedOrDeniedDocIds,
  driveUrlFor,
  type DriveDoc,
} from "@/lib/google-drive";
import { scanGmailForDocIds, buildInaccessibleDocs, type GmailInaccessibleDoc } from "@/lib/gmail";
import type { ParsedEmail } from "@/lib/parse-gmail-notification";
import { syncComments, type SyncPrefetchedData } from "@/lib/sync-comments";
import { mergeSuggestionsFromGmail } from "@/lib/suggestion-merge";
import { mergeCommentsFromGmail } from "@/lib/comment-merge";
import { getStatus, updateDriveChangesToken, updateGmailTimestamp } from "@/lib/status";
import { logWarning, logInfo } from "@/lib/log";
import { appendNotes, formatDate, pluralize } from "@/lib/utils";
import type { OnProgress } from "@/lib/progress-events";
import type { Doc } from "@prisma/client";
import pLimit from "p-limit";

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
  /** True when Gmail scan was skipped because the account has no Gmail mailbox. */
  noGmailAccount?: boolean;
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
    gmailEmailMeta?: Map<string, ParsedEmail[]>;
    mode?: "refresh" | "full-refresh" | "selected" | "load";
    docId?: string; // Optional: restrict upsert to a specific docId (for single-doc refresh)
    prefetched?: SyncPrefetchedData; // Pre-fetched data to avoid redundant API calls (single-doc refresh)
    /** Only unarchive docs with comment activity newer than this cutoff. Prevents
     *  stale docs from appearing in inbox when first synced during a bulk refresh. */
    unarchiveCutoff?: Date;
  },
  onProgress?: OnProgress,
): Promise<RefreshResult> {
  const { existingDocIds, fromGmailDocIdSet = new Set(), shareNotes, gmailEmailMeta, mode = "refresh", docId, prefetched, unarchiveCutoff } = options;
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
        title: "", // Titles not stored — fetched on demand from Drive API, cached in browser
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        role: doc.role,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        createdTimeInDrive: doc.createdTimeInDrive,
        notes: shareNotes?.get(doc.googleDocId) ?? null,
        lastCommentActivity: doc.createdTimeInDrive, // Initialize from creation time; comment sync will bump it up
        // Mode-based status defaults:
        // All new docs discovered via Drive activity start as ARCHIVED to avoid noise
        // from old docs resurfacing. We rely on Gmail notifications or the
        // subsequent comment sync (Phase 3) to move them to INBOX if relevant.
        status: fromGmail ? "INBOX" : "ARCHIVED",
      },
      update: {
        title: "", // Clear any previously stored title
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        createdTimeInDrive: doc.createdTimeInDrive,
        accessState: "OK",
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
        logInfo(`[Refresh]   UPDATE ${doc.googleDocId}`);
      }
      updated++;
    } else {
      logInfo(`[Refresh]   ADD ${doc.googleDocId} — ${doc.role}${fromGmail ? " [Gmail]" : ""}`);
      added++;
    }
  }

  // Signal that doc rows are up-to-date so the client can refresh the list
  // before the (potentially slow) comment/suggestion sync begins.
  onProgress?.({ phase: "docs-updated" });

  // Sync comments for all docs we just upserted
  logInfo(`[Refresh] Syncing comments for ${processedDocs.length} docs`);
  let syncCompleted = 0;
  let lastProgressTime = 0;
  const syncTotal = processedDocs.length;
  onProgress?.({ phase: "sync", completed: 0, total: syncTotal });
  const parallelismLimit = pLimit(10);
  const syncResults = await Promise.all(
    processedDocs.map((doc) => parallelismLimit(async () => {
      // prefetched is only set from single-doc refresh — safe to pass here
      // because processedDocs will contain exactly one doc in that case.
      const result = await syncComments(doc, driveAuth, userEmail, prefetched);
      // Merge suggestion data from Gmail notifications (if available for this doc).
      // Runs after syncComments so Drive-created suggestions with content hashes
      // are in the DB for hash matching. If Gmail arrived first, inserts new rows.
      // Process all emails for this doc (there may be multiple notifications).
      const emails = gmailEmailMeta?.get(doc.googleDocId);
      if (emails) {
        for (const email of emails) {
          const mergeResult = await mergeSuggestionsFromGmail(doc.docId, doc.googleDocId, email);
          result.suggestionsCreated += mergeResult.inserted;
          result.suggestionsUpdated += mergeResult.merged;
          if (mergeResult.shouldUnarchive) {
            result.shouldUnarchive = true;
          }
          // Merge comments from Gmail for docs where Drive can't list comments
          // (noCommentsPermission). No-op for docs with full access.
          const commentMergeResult = await mergeCommentsFromGmail(doc.docId, doc.googleDocId, email);
          result.commentsCreated += commentMergeResult.inserted;
          if (commentMergeResult.shouldUnarchive) {
            result.shouldUnarchive = true;
          }
        }
      }
      // Apply DB updates immediately so partial progress is visible on page reload
      if (result.isDeleted) {
        await prisma.doc.update({ where: { docId: doc.docId }, data: { accessState: "NOT_FOUND" } });
        deleted++;
      } else if (doc.status === "ARCHIVED" && result.shouldUnarchive) {
        // Note: result.permissionDenied means comment-level 403 (comments.list or
        // Docs API suggestions), NOT file-level. files.get already succeeded for
        // these docs, so accessState stays OK (see docs/access-states.md).
        // Skip unarchive if comment activity is older than the cutoff — prevents
        // stale docs from appearing in inbox when first synced during bulk refresh.
        let recentEnough = true;
        if (unarchiveCutoff) {
          const fresh = await prisma.doc.findUnique({ where: { docId: doc.docId }, select: { lastCommentActivity: true } });
          if (!fresh?.lastCommentActivity || fresh.lastCommentActivity < unarchiveCutoff) {
            recentEnough = false;
            logInfo(`[Refresh] Skipping unarchive for ${doc.googleDocId} — last comment activity ${fresh?.lastCommentActivity?.toISOString() ?? "null"} is before cutoff ${unarchiveCutoff.toISOString()}`);
          }
        }
        if (recentEnough) {
          await prisma.doc.update({ where: { docId: doc.docId }, data: { status: "INBOX" } });
          unarchived++;
        }
      }
      syncCompleted++;
      const now = Date.now();
      if (syncCompleted === syncTotal || now - lastProgressTime >= 500) {
        lastProgressTime = now;
        onProgress?.({ phase: "sync", completed: syncCompleted, total: syncTotal });
      }
      return result;
    }))
  );
  const commentsCreated = syncResults.reduce((sum, r) => sum + r.commentsCreated, 0);
  const commentsUpdated = syncResults.reduce((sum, r) => sum + r.commentsUpdated, 0);
  const suggestionsCreated = syncResults.reduce((sum, r) => sum + r.suggestionsCreated, 0);
  const suggestionsUpdated = syncResults.reduce((sum, r) => sum + r.suggestionsUpdated, 0);

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
 * Drive metadata fetch, check whether they are actually deleted/trashed or
 * permission-denied and mark them accordingly in the database.
 * Returns the number of docs marked as deleted.
 */
async function markMissingAsDeletedOrDenied(
  userId: string,
  missingIds: string[],
  logLabel: string,
): Promise<number> {
  if (missingIds.length === 0) return 0;
  logInfo(`[Refresh] Checking ${missingIds.length} missing ${logLabel} docs for deletion/permission`);
  const { trashedIds, deletedIds, permissionDeniedIds } = await findDeletedOrDeniedDocIds(userId, missingIds);
  let count = 0;
  for (const id of missingIds) {
    if (trashedIds.has(id)) {
      // Only count as changed if the doc wasn't already TRASHED
      const result = await prisma.doc.updateMany({
        where: { userId, googleDocId: id, accessState: { not: "TRASHED" } },
        data: { accessState: "TRASHED" },
      });
      count += result.count;
    } else if (deletedIds.has(id)) {
      // 404 is ambiguous for DENIED docs — keep DENIED state (see docs/access-states.md)
      const result = await prisma.doc.updateMany({
        where: { userId, googleDocId: id, accessState: { notIn: ["DENIED", "NOT_FOUND"] } },
        data: { accessState: "NOT_FOUND" },
      });
      count += result.count;
    } else if (permissionDeniedIds.has(id)) {
      await prisma.doc.updateMany({
        where: { userId, googleDocId: id, accessState: { not: "DENIED" } },
        data: { accessState: "DENIED" },
      });
    }
  }
  return count;
}

/**
 * Handles Gmail docs that were not returned by fetchDocsByIds.
 * Checks if they were deleted/access revoked in Drive.
 */
async function handleMissingGmailDocs(
  userId: string,
  gmailDocIds: string[],
  returnedDocIds: Set<string>,
  existingDocIds: Set<string>
): Promise<number> {
  const missingIds = gmailDocIds.filter((id) => !returnedDocIds.has(id) && existingDocIds.has(id));
  return markMissingAsDeletedOrDenied(userId, missingIds, "gmail");
}

/**
 * Insert docs discovered via Gmail notifications that we can't access (404/403).
 * Creates new DB entries with the appropriate accessState, skipping docs already in DB.
 * Returns the number of docs inserted.
 */
export async function insertInaccessibleDocs(
  userId: string,
  docs: GmailInaccessibleDoc[],
  options?: { labelIds?: string[]; extraNotes?: string; status?: "INBOX" | "ARCHIVED"; isStarred?: boolean },
): Promise<number> {
  if (docs.length === 0) return 0;

  const existingGoogleDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId, googleDocId: { in: docs.map(d => d.googleDocId) } },
      select: { googleDocId: true },
    })).map(d => d.googleDocId)
  );

  let count = 0;
  for (const doc of docs) {
    if (existingGoogleDocIds.has(doc.googleDocId)) continue;
    try {
      let notes = doc.notes;
      if (options?.extraNotes) {
        notes = appendNotes(notes, options.extraNotes);
      }

      await prisma.$transaction(async (tx) => {
        const result = await tx.doc.create({
          data: {
            userId,
            googleDocId: doc.googleDocId,
            title: doc.title,
            driveUrl: driveUrlFor(doc.googleDocId),
            accessState: doc.accessState,
            status: options?.status ?? "INBOX",
            role: "REVIEWER",
            notes,
            isStarred: options?.isStarred ?? false,
            createdTimeInDrive: doc.emailDate,
            lastModifiedInDrive: doc.emailDate,
            lastCommentActivity: doc.emailDate,
          },
        });

        if (options?.labelIds?.length) {
          await tx.docLabel.createMany({
            data: options.labelIds.map((labelId) => ({ docId: result.docId, labelId })),
            skipDuplicates: true,
          });
        }
      });

      count++;
      logInfo(`[Sync] Added inaccessible doc ${doc.googleDocId} (${doc.accessState})`);
    } catch (err) {
      logWarning(`[Sync] Failed to insert inaccessible doc ${doc.googleDocId}:`, err);
    }
  }
  return count;
}

/**
 * Direct metadata refresh for a known set of Google Doc IDs.
 * Used by "Refresh Selected" and "Full Refresh" (all docs).
 * Skips Drive/Gmail discovery — goes straight to metadata fetch + upsert + sync.
 */
async function executeDirectRefresh(
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
  // Metadata fetch
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

  // Deletion detection: docs not returned by fetchDocsByIds may be deleted
  const foundIds = new Set(driveDocs.map(d => d.googleDocId));
  const missingIds = googleDocIds.filter(id => !foundIds.has(id));
  const additionalDeleted = await markMissingAsDeletedOrDenied(userId, missingIds, mode);

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
  return result;
}

export async function executeRefresh(
  userId: string,
  userEmail: string | undefined,
  options: {
    drive?: boolean;
    gmail?: boolean;
    googleDocIds?: string[];
    mode?: "selected" | "full-refresh";
    onProgress?: OnProgress;
  },
): Promise<RefreshResult> {
  const t0 = Date.now();
  const { drive: includeDrive = false, gmail: includeGmail = false, googleDocIds, mode, onProgress } = options;

  // --- Direct metadata path (selected / full-refresh) ---
  if (googleDocIds) {
    return executeDirectRefresh(userId, userEmail, googleDocIds, mode ?? "selected", onProgress);
  }

  // --- Discovery path (drive / gmail / both) ---
  const sourceNames = [includeDrive && "drive", includeGmail && "gmail"].filter(Boolean).join(", ");
  logInfo(`[Refresh] Starting refresh (sources: ${sourceNames})`);

  // Shared setup
  const status = await getStatus(userId);

  // --- Discovery phase (parallel) ---
  let driveDocs: DriveDoc[] = [];
  let trashedDocIdsFromDrive = new Set<string>();
  let removedDocIdsFromDrive = new Set<string>();
  let newPageToken: string | undefined;
  let driveSucceeded = false;

  let gmailDocIds: string[] = [];
  let gmailShareNotes = new Map<string, string>();
  let gmailEmailMeta = new Map<string, ParsedEmail[]>();
  let gmailErrorCount = 0;
  let gmailSucceeded = false;
  let gmailNoAccount = false;

  let staleGoogleDocIds: string[] = [];

  const discoveryPromises: Promise<void>[] = [];

  // Catch-up: find docs with stale comments (never synced, or synced before
  // last Drive modification). Runs in parallel with Drive/Gmail discovery.
  discoveryPromises.push((async () => {
    const rows = await prisma.$queryRaw<{ google_doc_id: string; title: string; comments_last_synced_at: Date | null }[]>`
      SELECT google_doc_id, title, comments_last_synced_at FROM docs
      WHERE user_id = ${userId}
        AND access_state = 'OK'
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
        logInfo(`[Refresh]   STALE ${r.google_doc_id} — ${reason}`);
      }
    }
  })());

  let driveChangesRead = 0;
  // Cutoff for unarchiving: only unarchive docs with comment activity newer
  // than this. Derived from the oldest change timestamp (minus 1 day buffer)
  // when using changes.list, or 7 days ago for the files.list fallback.
  let unarchiveCutoff: Date | undefined;

  if (includeDrive) {
    discoveryPromises.push((async () => {
      onProgress?.({ phase: "drive", status: "reading", count: 0 });
      const savedToken = status?.driveChangesPageToken;
      if (savedToken) {
        logInfo("[Refresh] Drive: using changes.list with saved token");
        try {
          const result = await listChanges(userId, savedToken, (stats) => {
            onProgress?.({ phase: "drive", status: "reading", ...stats });
          });
          driveDocs = result.docs;
          driveChangesRead = result.rawChangeCount;
          trashedDocIdsFromDrive = result.trashedDocIds;
          removedDocIdsFromDrive = result.removedDocIds;
          newPageToken = result.newPageToken;
          if (result.oldestChangeTime) {
            unarchiveCutoff = new Date(result.oldestChangeTime.getTime() - 24 * 60 * 60 * 1000);
          }
          driveSucceeded = true;
          onProgress?.({ phase: "drive", status: "done", count: driveDocs.length, totalChanges: result.rawChangeCount });
        } catch (err: unknown) {
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            logWarning("[Refresh] Drive: changes.list token expired, falling back to 7-day files.list");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId, undefined, undefined, (stats) => {
              onProgress?.({ phase: "drive", status: "reading", ...stats });
            });
            driveChangesRead = driveDocs.length;
            unarchiveCutoff = new Date(Date.now() - DEFAULT_GMAIL_DAYS_BACK * 24 * 60 * 60 * 1000);
            driveSucceeded = true;
            onProgress?.({ phase: "drive", status: "done", count: driveDocs.length, totalChanges: driveDocs.length });
          } else {
            throw err;
          }
        }
      } else {
        logInfo("[Refresh] Drive: no saved token, bootstrapping (7-day files.list)");
        newPageToken = await getChangesStartPageToken(userId);
        driveDocs = await listRecentDocs(userId, undefined, undefined, (stats) => {
          onProgress?.({ phase: "drive", status: "reading", ...stats });
        });
        driveChangesRead = driveDocs.length;
        unarchiveCutoff = new Date(Date.now() - DEFAULT_GMAIL_DAYS_BACK * 24 * 60 * 60 * 1000);
        driveSucceeded = true;
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
      const result = await scanGmailForDocIds(userId, since, userEmail, (count, total) => {
        onProgress?.({ phase: "gmail", status: "reading", count, total });
      });
      gmailDocIds = result.docIds;
      gmailShareNotes = result.shareNotes;
      gmailEmailMeta = result.emailMeta;
      gmailErrorCount = result.errorCount;
      gmailSucceeded = true;
      gmailNoAccount = result.noGmailAccount === true;
      logInfo(`[Refresh] Gmail: ${gmailDocIds.length} doc IDs (${gmailErrorCount} errors)`);
      onProgress?.({ phase: "gmail", status: "done", count: gmailDocIds.length, errorCount: gmailErrorCount, noGmailAccount: result.noGmailAccount });
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

  // Insert inaccessible docs discovered via Gmail that failed Drive metadata fetch
  let inaccessibleAdded = 0;
  if (gmailOnlyIds.length > 0 && gmailEmailMeta.size > 0) {
    const returnedExtraIds = new Set(extraDocs.map((d) => d.googleDocId));
    const failedNewIds = gmailOnlyIds.filter((id) => !returnedExtraIds.has(id) && !existingDocIds.has(id));
    if (failedNewIds.length > 0) {
      const inaccessible = buildInaccessibleDocs(failedNewIds, gmailEmailMeta);
      inaccessibleAdded = await insertInaccessibleDocs(userId, inaccessible);
    }
  }

  // Merge comments from Gmail for docs that didn't go through upsertDocsAndSyncComments.
  // This covers both newly inserted inaccessible docs AND existing docs whose Drive
  // metadata fetch failed (they never reach syncComments, so Gmail is the only source).
  let gmailMergeUnarchived = 0;
  {
    const processedGoogleDocIds = new Set(allDiscoveryDocs.map(d => d.googleDocId));
    const unprocessedGmailIds = gmailDocIds.filter(id => !processedGoogleDocIds.has(id));
    if (unprocessedGmailIds.length > 0) {
      const dbDocs = await prisma.doc.findMany({
        where: { userId, googleDocId: { in: unprocessedGmailIds } },
        select: { docId: true, googleDocId: true, status: true },
      });
      for (const dbDoc of dbDocs) {
        const emails = gmailEmailMeta.get(dbDoc.googleDocId);
        if (!emails) continue;
        let shouldUnarchive = false;
        for (const email of emails) {
          const r = await mergeCommentsFromGmail(dbDoc.docId, dbDoc.googleDocId, email);
          if (r.shouldUnarchive) shouldUnarchive = true;
        }
        if (shouldUnarchive && dbDoc.status === "ARCHIVED") {
          let recentEnough = true;
          if (unarchiveCutoff) {
            const fresh = await prisma.doc.findUnique({ where: { docId: dbDoc.docId }, select: { lastCommentActivity: true } });
            if (!fresh?.lastCommentActivity || fresh.lastCommentActivity < unarchiveCutoff) {
              recentEnough = false;
              logInfo(`[Refresh] Skipping unarchive for ${dbDoc.googleDocId} — last comment activity ${fresh?.lastCommentActivity?.toISOString() ?? "null"} is before cutoff ${unarchiveCutoff.toISOString()}`);
            }
          }
          if (recentEnough) {
            await prisma.doc.update({ where: { docId: dbDoc.docId }, data: { status: "INBOX" } });
            gmailMergeUnarchived++;
          }
        }
      }
    }
  }

  const syncRes = await upsertDocsAndSyncComments(
    userId,
    userEmail,
    allDiscoveryDocs,
    { existingDocIds, fromGmailDocIdSet: gmailDocIdSet, shareNotes: gmailShareNotes, gmailEmailMeta, mode: "refresh", unarchiveCutoff },
    onProgress,
  );

  let extraDeleted = 0;
  // Handle trashed docs from Drive changes.list
  if (trashedDocIdsFromDrive.size > 0) {
    const docsToTrash = await prisma.doc.findMany({
      where: {
        userId,
        accessState: { not: "TRASHED" }, // Only count docs not already trashed
        googleDocId: { in: [...trashedDocIdsFromDrive] },
      },
      select: { docId: true, googleDocId: true, title: true },
    });
    logInfo(`[Refresh] Drive: ${docsToTrash.length} of ${trashedDocIdsFromDrive.size} trashed were tracked docs`);
    for (const doc of docsToTrash) {
      await prisma.doc.update({ where: { docId: doc.docId }, data: { accessState: "TRASHED" } });
      extraDeleted++;
    }
  }
  // Handle removed docs from Drive changes.list (removed = no longer accessible, ambiguous)
  if (removedDocIdsFromDrive.size > 0) {
    const docsToRemove = await prisma.doc.findMany({
      where: {
        userId,
        accessState: { notIn: ["DENIED", "NOT_FOUND"] }, // Don't overwrite DENIED (404 ambiguity) or re-count NOT_FOUND
        googleDocId: { in: [...removedDocIdsFromDrive] },
      },
      select: { docId: true, googleDocId: true, title: true },
    });
    logInfo(`[Refresh] Drive: ${docsToRemove.length} of ${removedDocIdsFromDrive.size} removals were tracked docs`);
    for (const doc of docsToRemove) {
      await prisma.doc.update({ where: { docId: doc.docId }, data: { accessState: "NOT_FOUND" } });
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

  // Skip the timestamp update when the account has no Gmail mailbox — we never
  // actually scanned anything, so advancing the cursor would silently lose any
  // window if Gmail later becomes available for this account.
  if (gmailSucceeded && !gmailNoAccount && syncRes.errorCount === 0 && !allFailed && gmailErrorCount === 0) {
    await updateGmailTimestamp(userId, new Date());
  }

  const elapsed = Date.now() - t0;
  const totalErrorCount = gmailErrorCount + syncRes.errorCount;
  const totalDeleted = syncRes.deleted + extraDeleted;
  const counts = [
    pluralize(syncRes.added + inaccessibleAdded, "doc") + " added",
    pluralize(syncRes.updated, "doc") + " updated",
    pluralize(totalDeleted, "doc") + " deleted",
    pluralize(syncRes.unarchived + gmailMergeUnarchived, "doc") + " unarchived",
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
  return {
    ...syncRes,
    added: syncRes.added + inaccessibleAdded,
    deleted: totalDeleted,
    unarchived: syncRes.unarchived + gmailMergeUnarchived,
    errorCount: totalErrorCount,
    driveChangesRead,
    totalDocuments: allDiscoveryDocs.length,
    ...(gmailNoAccount ? { noGmailAccount: true } : {}),
  };
}


import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { fetchDocsByIds, getDriveClient, invalidGrantResponse } from "@/lib/google-drive";
import { scanGmailNotifications } from "@/lib/gmail";
import { logError, logWarning, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { handleMissingGmailDocs, upsertDocsAndSyncComments } from "@/lib/refresh";
import { getStatus, updateGmailTimestamp } from "@/lib/status";
import { formatDate, pluralize } from "@/lib/utils";

const DEFAULT_DAYS_BACK = 7;

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? undefined;

  logInfo("[GmailRefresh] Starting incremental Gmail refresh");
  const t0 = Date.now();

  try {
    // Determine scan window
    const status = await getStatus(userId);
    const since = status?.lastGmailUpdateTimestamp
      ?? new Date(Date.now() - DEFAULT_DAYS_BACK * 24 * 60 * 60 * 1000);
    logInfo(`[GmailRefresh] Scanning since ${formatDate(since)}`);

    // Scan Gmail for doc notifications
    const { docs: gmailDocs, shareNotes, errorCount: scannerErrorCount, skipCount } = await scanGmailNotifications(userId, since);
    if (gmailDocs.length === 0) {
      logInfo(`[GmailRefresh] No docs found in Gmail (${scannerErrorCount} errors, ${skipCount} skipped)`);
      // Only update timestamp if there were no actual errors
      if (scannerErrorCount === 0) {
        await updateGmailTimestamp(userId, new Date());
      }
      return NextResponse.json({ added: 0, updated: 0, deleted: 0, unarchived: 0, errorCount: scannerErrorCount, comments: 0 });
    }

    // Fetch full Drive metadata for discovered docs
    const docIds = [...new Set(gmailDocs.map((d) => d.googleDocId))];
    logInfo(`[GmailRefresh] Fetching Drive metadata for ${docIds.length} docs from Gmail`);
    const driveDocs = await fetchDocsByIds(userId, docIds);
    const gmailDocIdSet = new Set(gmailDocs.map(d => d.googleDocId));

    // Pre-fetch existing doc IDs to distinguish adds from updates
    const existingDocIds = new Set(
      (await prisma.doc.findMany({
        where: { userId },
        select: { googleDocId: true },
      })).map((d) => d.googleDocId)
    );

    // Use shared logic for upsert and comment sync
    const syncRes = await upsertDocsAndSyncComments(userId, userEmail, driveDocs, {
      existingDocIds,
      fromGmailDocIdSet: gmailDocIdSet,
      shareNotes,
      mode: "refresh"
    });

    // Detect deletions: scan doc IDs found in Gmail but not returned by fetchDocsByIds
    const returnedIds = new Set(driveDocs.map((d) => d.googleDocId));
    const extraDeleted = await handleMissingGmailDocs(userId, docIds, returnedIds, existingDocIds);

    const totalDeleted = syncRes.deleted + extraDeleted;
    const totalErrorCount = scannerErrorCount + syncRes.errorCount;

    // Update timestamp for next incremental scan only if no errors occurred
    // We check both scanner errors and sync/fetch errors (transient errors in syncRes)
    if (totalErrorCount === 0 && syncRes.successCount === syncRes.totalAttempted) {
      await updateGmailTimestamp(userId, new Date());
    } else {
      logWarning(`[GmailRefresh] Sync issues (errors: ${totalErrorCount}), skipping timestamp update`);
    }

    const elapsed = Date.now() - t0;
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
    logInfo(`[GmailRefresh] Complete in ${elapsed}ms: ${counts.join(", ")}, ${commentStr}${suggestionStr} (${pluralize(totalErrorCount, "error")})`);
    
    return NextResponse.json({
      ...syncRes,
      deleted: totalDeleted,
      errorCount: totalErrorCount,
      // Backward compatibility
      comments: syncRes.commentsCreated + syncRes.suggestionsCreated
    });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError("[GmailRefresh] Error:", err);
    return NextResponse.json({ error: "Failed to refresh from Gmail" }, { status: 502 });
  }
  });
}

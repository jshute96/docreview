import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, fetchDocsByIds, getDriveClient, getChangesStartPageToken, listChanges } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { pluralize } from "@/lib/utils";
import { executeFullRefresh } from "@/lib/refresh";
import { getStatus, updateDriveChangesToken } from "@/lib/status";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { parseLoadOptions } from "@/lib/load-options";
import { logWarning, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { createProgressStream } from "@/lib/sse";
import type { OnProgress } from "@/lib/progress-events";

export async function GET(req: NextRequest) {
  return runWithRequestId("GET", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "true";
  const labelIds = searchParams.getAll("labelId");

  const rawDocs = await prisma.doc.findMany({
    where: {
      userId,
      ...(includeArchived ? {} : { status: "INBOX" }),
      ...(labelIds.length > 0
        ? { labels: { some: { labelId: { in: labelIds } } } }
        : {}),
    },
    include: docWithCountsInclude,
    orderBy: { lastModifiedInDrive: "desc" },
  });

  return NextResponse.json(rawDocs.map(withCommentCounts));
  });
}

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? undefined;

  const { searchParams } = new URL(req.url);
  const modeParam = searchParams.get("mode");
  const mode: "refresh" | "full-refresh" | "load" =
    modeParam === "refresh" ? "refresh"
    : modeParam === "full-refresh" ? "full-refresh"
    : "load";

  // Parse load options from request body (load mode only)
  let loadBody: Record<string, unknown> = {};
  if (mode === "load") {
    try { loadBody = await req.json(); } catch { /* no body is fine */ }
  }
  const { daysBack, ownership, includeSharedDrives, source } = parseLoadOptions(loadBody);
  const selectedSet = Array.isArray(loadBody.selectedGoogleDocIds)
    ? new Set(loadBody.selectedGoogleDocIds as string[])
    : null;
  const loadLabelIds: string[] = Array.isArray(loadBody.labelIds) ? loadBody.labelIds as string[] : [];
  const loadNotes: string = typeof loadBody.notes === "string" ? (loadBody.notes as string).trim() : "";
  const loadStatus: "INBOX" | "ARCHIVED" | undefined = typeof loadBody.status === "string" && (loadBody.status === "INBOX" || loadBody.status === "ARCHIVED") ? (loadBody.status as "INBOX" | "ARCHIVED") : undefined;
  const loadIsStarred: boolean | undefined = typeof loadBody.isStarred === "boolean" ? loadBody.isStarred : undefined;

  // Validate label ownership before proceeding
  if (loadLabelIds.length > 0) {
    const ownedLabels = await prisma.label.findMany({
      where: { labelId: { in: loadLabelIds }, userId },
      select: { labelId: true },
    });
    if (ownedLabels.length !== loadLabelIds.length) {
      return NextResponse.json({ error: "Invalid label" }, { status: 400 });
    }
  }

  logInfo(`[Sync] Starting ${mode} sync`);
  if (mode === "full-refresh") {
    return createProgressStream(async (send) => {
      const result = await executeFullRefresh(userId, userEmail, send);
      return {
        ...result,
        mode: "full-refresh" as const,
        total: result.updated + result.added,
      };
    });
  }

  if (mode === "load") {
    logInfo(`[Sync] Load options: source=${source}, daysBack=${daysBack}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}${selectedSet ? `, ${selectedSet.size} docs selected` : ""}`);
  }

  return createProgressStream(async (send: OnProgress) => {
    return await executeLoadOrRefresh({
      userId, userEmail, mode, source,
      selectedSet, loadLabelIds, loadNotes, loadStatus, loadIsStarred, send,
    });
  });
  });
}

async function executeLoadOrRefresh(opts: {
  userId: string;
  userEmail: string | undefined;
  mode: "refresh" | "load";
  source: string;
  selectedSet: Set<string> | null;
  loadLabelIds: string[];
  loadNotes: string;
  loadStatus: "INBOX" | "ARCHIVED" | undefined;
  loadIsStarred: boolean | undefined;
  send: OnProgress;
}) {
  const {
    userId, userEmail, mode, source, selectedSet,
    loadLabelIds, loadNotes, loadStatus, loadIsStarred, send,
  } = opts;
  const t0 = Date.now();

  let driveDocs: import("@/lib/google-drive").DriveDoc[] = [];
  let deletedDocIds = new Set<string>();
  let driveAuth;
  let newPageToken: string | undefined;

  driveAuth = await getDriveClient(userId);

  if (mode === "load") {
    // Load mode: fetch metadata directly by selected doc IDs
    const docIds = selectedSet ? [...selectedSet] : [];
    logInfo(`[Sync] Load (${source}): fetching metadata for ${docIds.length} docs by ID`);
    send({ phase: "metadata", count: docIds.length });
    driveDocs = await fetchDocsByIds(userId, docIds);
  } else {
    // Refresh: use changes.list with saved token
    send({ phase: "drive", status: "reading" });
    const status = await getStatus(userId);
    const savedToken = status?.driveChangesPageToken;

    if (savedToken) {
      logInfo(`[Sync] ${mode}: using changes.list with saved token`);
      try {
        const result = await listChanges(userId, savedToken);
        driveDocs = result.docs;
        deletedDocIds = result.deletedDocIds;
        newPageToken = result.newPageToken;
        logInfo(`[Sync] changes.list -> ${driveDocs.length} changed docs, ${deletedDocIds.size} deletions, newPageToken ${newPageToken}`);
      } catch (err: unknown) {
        // Expired/invalid token -> fall back to bootstrap
        const code = (err as { code?: number | string })?.code;
        if (code === 404 || code === "404") {
          logWarning("[Sync] changes.list token expired, falling back to bootstrap (7-day files.list)");
          newPageToken = await getChangesStartPageToken(userId);
          driveDocs = await listRecentDocs(userId);
        } else {
          throw err;
        }
      }
    } else {
      logInfo(`[Sync] ${mode}: no saved token, bootstrapping (7-day files.list)`);
      newPageToken = await getChangesStartPageToken(userId);
      driveDocs = await listRecentDocs(userId);
    }
    send({ phase: "drive", status: "done", count: driveDocs.length });
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const driveDocIds = new Set(driveDocs.map((d) => d.googleDocId));
  logInfo(`[Sync] Drive returned ${driveDocs.length} docs — processing each:`);

  // Pre-fetch existing doc IDs to distinguish adds from updates
  const existingDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId },
      select: { googleDocId: true },
    })).map((d) => d.googleDocId)
  );

  for (const doc of driveDocs) {
    const isExisting = existingDocIds.has(doc.googleDocId);

    // Refresh: auto-add new docs I authored; skip others.
    // Shared-with-me docs arrive via gmail-refresh notifications instead.
    if (mode === "refresh" && !isExisting && doc.role !== "AUTHOR") {
      logInfo(`[Sync]   SKIP "${doc.title}" — new ${doc.role} doc (${mode} only auto-adds AUTHOR docs)`);
      continue;
    }

    // Load mode with selection: skip docs not selected by user
    const isSelected = !selectedSet || selectedSet.has(doc.googleDocId);
    if (mode === "load" && !isSelected) {
      logInfo(`[Sync]   SKIP "${doc.title}" — not selected by user`);
      continue;
    }

    const result = await prisma.doc.upsert({
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
        status: loadStatus ?? (doc.role === "AUTHOR" ? "INBOX" : "ARCHIVED"),
        ...(loadIsStarred !== undefined ? { isStarred: loadIsStarred } : {}),
        ...(loadNotes ? { notes: loadNotes } : {}),
        ...(loadLabelIds.length > 0
          ? { labels: { create: loadLabelIds.map((id) => ({ labelId: id })) } }
          : {}),
      },
      update: {
        title: doc.title,
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        owner: doc.owner,
        createdTimeInDrive: doc.createdTimeInDrive,
        isDeleted: false,
        ...(loadStatus === "INBOX" ? { status: "INBOX" as const } : {}),
        ...(loadIsStarred !== undefined ? { isStarred: loadIsStarred } : {}),
      },
      select: { docId: true, notes: true },
    });

    // For existing docs selected in load mode, add labels and append notes
    if (isExisting && mode === "load" && isSelected) {
      if (loadLabelIds.length > 0) {
        await prisma.docLabel.createMany({
          data: loadLabelIds.map((labelId) => ({ docId: result.docId, labelId })),
          skipDuplicates: true,
        });
      }
      if (loadNotes) {
        let newNotes = result.notes ?? "";
        if (newNotes.length > 0 && !newNotes.endsWith("\n")) {
          newNotes += "\n";
        }
        newNotes += loadNotes;
        await prisma.doc.update({
          where: { docId: result.docId },
          data: { notes: newNotes },
        });
      }
    }

    if (isExisting) {
      logInfo(`[Sync]   UPDATE "${doc.title}" — already tracked, metadata updated`);
      updated++;
    } else {
      logInfo(`[Sync]   ADD "${doc.title}" — new ${doc.role} doc (owner: ${doc.owner ?? "unknown"})`);
      added++;
    }
  }

  // Handle deletions detected by changes.list (refresh)
  if (deletedDocIds.size > 0) {
    logInfo(`[Sync] Processing ${deletedDocIds.size} deletions from changes.list`);
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

  // Note: deletion detection for existing docs is handled by refresh
  // mode (via changes.list). Load mode only processes the specific docs the user
  // selected, so there's no meaningful "missing from results" set to check.

  // Sync comments for docs returned by Drive
  const commentDocs = await prisma.doc.findMany({
    where: { userId, isDeleted: false, googleDocId: { in: [...driveDocIds] } },
  });
  logInfo(`[Sync] Syncing comments for ${commentDocs.length} docs (${mode === "refresh" ? "changed docs only" : "selected docs"})`);

  let syncCompleted = 0;
  let lastProgressTime = 0;
  const syncTotal = commentDocs.length;
  send({ phase: "sync", completed: 0, total: syncTotal });
  const syncResults = await Promise.all(
    commentDocs.map(async (doc) => {
      const result = await syncComments(doc, driveAuth, userEmail);
      syncCompleted++;
      const now = Date.now();
      if (syncCompleted === syncTotal || now - lastProgressTime >= 500) {
        lastProgressTime = now;
        send({ phase: "sync", completed: syncCompleted, total: syncTotal });
      }
      return result;
    })
  );
  const commentsCreated = syncResults.reduce((sum, r) => sum + r.commentsCreated, 0);
  const commentsUpdated = syncResults.reduce((sum, r) => sum + r.commentsUpdated, 0);
  const suggestionsCreated = syncResults.reduce((sum, r) => sum + r.suggestionsCreated, 0);
  const suggestionsUpdated = syncResults.reduce((sum, r) => sum + r.suggestionsUpdated, 0);

  // Unarchive ARCHIVED docs only when syncComments detected meaningful new activity.
  // Also handle newly detected deletions from syncComments results.
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

  // Save changes page token only if no transient errors occurred.
  // For load mode, initialize the token so subsequent refreshes use changes.list.
  // Safety: if *every* doc failed (transient, permission denied, or deleted),
  // something systemic may be wrong — skip the token update so the next refresh
  // retries from the same point.  See refresh.ts for the full rationale.
  const transientErrors = syncResults
    .map((r, i) => r.transientError ? commentDocs[i].googleDocId : null)
    .filter((id): id is string => id !== null);

  const permissionErrors = syncResults
    .map((r, i) => r.permissionDenied ? commentDocs[i].googleDocId : null)
    .filter((id): id is string => id !== null);

  const successCount = syncResults.filter(r => !r.transientError && !r.permissionDenied && !r.isDeleted).length;
  const allFailed = commentDocs.length > 0 && successCount === 0;

  if (permissionErrors.length > 0) {
    logInfo(`[Sync] Comment access denied for ${permissionErrors.length} docs (skipped): ${permissionErrors.join(", ")}`);
  }

  if (transientErrors.length === 0 && !allFailed) {
    if (newPageToken) {
      logInfo(`[Sync] Saving changes token for future refreshes`);
      await updateDriveChangesToken(userId, newPageToken);
    } else if (mode === "load") {
      logInfo("[Sync] Load complete, initializing changes token for future refreshes");
      const token = await getChangesStartPageToken(userId);
      await updateDriveChangesToken(userId, token);
    }
  } else if (allFailed) {
    logWarning(`[Sync] All ${commentDocs.length} document fetches failed, skipping token update for safety`);
  } else {
    logWarning(`[Sync] Transient errors during comment sync for ${transientErrors.length} docs, skipping token update: ${transientErrors.join(", ")}`);
  }

  const elapsed = Date.now() - t0;
  const counts = [
    pluralize(added, "doc") + " added",
    pluralize(updated, "doc") + " updated",
    pluralize(deleted, "doc") + " deleted",
    pluralize(unarchived, "doc") + " unarchived",
  ];
  const commentStr = `${pluralize(commentsCreated, "new comment thread")}, ${pluralize(commentsUpdated, "updated comment thread")}`;
  const suggestionStr = suggestionsCreated > 0 || suggestionsUpdated > 0
    ? `, ${pluralize(suggestionsCreated, "new suggestion")}, ${pluralize(suggestionsUpdated, "updated suggestion")}`
    : "";
  logInfo(`[Sync] ${mode} complete in ${elapsed}ms: ${counts.join(", ")}, ${commentStr}${suggestionStr}`);
  return {
    mode,
    added,
    updated,
    deleted,
    unarchived,
    total: driveDocs.length,
    commentsCreated,
    commentsUpdated,
    suggestionsCreated,
    suggestionsUpdated,
  };
}

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { fetchDocsByIds, getDriveClient, getChangesStartPageToken } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { appendNotes, pluralize } from "@/lib/utils";
import { insertInaccessibleDocs } from "@/lib/refresh";
import type { GmailInaccessibleDoc } from "@/lib/gmail";
import { updateDriveChangesToken } from "@/lib/status";
import { docWithCountsInclude, withCommentCounts, stripServerOnly } from "@/lib/doc-queries";
import { parseLoadOptions } from "@/lib/load-options";
import { logWarning, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { validateLabelOwnership } from "@/lib/add-doc";
import { createProgressStream } from "@/lib/sse";
import type { OnProgress } from "@/lib/progress-events";
import pLimit from "p-limit";
import { AccessState, DocRole, DocStatus } from "@prisma/client";

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
      ...(includeArchived ? {} : { status: DocStatus.INBOX }),
      ...(labelIds.length > 0
        ? { labels: { some: { labelId: { in: labelIds } } } }
        : {}),
    },
    include: docWithCountsInclude,
    orderBy: { lastModifiedInDrive: "desc" },
  });

  return NextResponse.json(rawDocs.map(withCommentCounts).map(stripServerOnly));
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

  let loadBody: Record<string, unknown> = {};
  try { loadBody = await req.json(); } catch { /* no body is fine */ }

  const { source } = parseLoadOptions(loadBody);
  const selectedSet = Array.isArray(loadBody.selectedGoogleDocIds)
    ? new Set(loadBody.selectedGoogleDocIds as string[])
    : null;
  const loadLabelIds: string[] = Array.isArray(loadBody.labelIds) ? loadBody.labelIds as string[] : [];
  const loadNotes: string = typeof loadBody.notes === "string" ? (loadBody.notes as string).trim() : "";
  const loadStatus: DocStatus | undefined = typeof loadBody.status === "string" && (loadBody.status === DocStatus.INBOX || loadBody.status === DocStatus.ARCHIVED) ? loadBody.status as DocStatus : undefined;
  const loadIsStarred: boolean | undefined = typeof loadBody.isStarred === "boolean" ? loadBody.isStarred : undefined;
  const loadInaccessibleDocs: GmailInaccessibleDoc[] = Array.isArray(loadBody.inaccessibleDocs)
    ? (loadBody.inaccessibleDocs as any[])
        .filter((d: any) => d.googleDocId && d.title && (d.accessState === AccessState.NOT_FOUND || d.accessState === AccessState.DENIED))
        .map((d: any) => ({
          ...d,
          emailDate: d.emailDate ? new Date(d.emailDate) : new Date(),
        }))
    : [];

  // Validate label ownership before proceeding
  const labelError = await validateLabelOwnership(userId, loadLabelIds);
  if (labelError) return labelError;

  logInfo(`[Sync] Starting load sync`);
  logInfo(`[Sync] Load options: source=${source}${selectedSet ? `, ${selectedSet.size} docs selected` : ""}`);

  return createProgressStream(async (send: OnProgress) => {
    return await executeLoad({
      userId, userEmail, source,
      selectedSet, loadLabelIds, loadNotes, loadStatus, loadIsStarred, loadInaccessibleDocs, send,
    });
  });
  });
}

async function executeLoad(opts: {
  userId: string;
  userEmail: string | undefined;
  source: string;
  selectedSet: Set<string> | null;
  loadLabelIds: string[];
  loadNotes: string;
  loadStatus: DocStatus | undefined;
  loadIsStarred: boolean | undefined;
  loadInaccessibleDocs: GmailInaccessibleDoc[];
  send: OnProgress;
}) {
  const {
    userId, userEmail, source, selectedSet,
    loadLabelIds, loadNotes, loadStatus, loadIsStarred, loadInaccessibleDocs, send,
  } = opts;
  const t0 = Date.now();

  const driveAuth = await getDriveClient(userId);

  // Load mode: fetch metadata directly by selected doc IDs
  // Exclude inaccessible docs — they can't be fetched from Drive
  const inaccessibleIds = new Set(loadInaccessibleDocs.map(d => d.googleDocId));
  const docIds = selectedSet ? [...selectedSet].filter(id => !inaccessibleIds.has(id)) : [];
  logInfo(`[Sync] Load (${source}): fetching metadata for ${docIds.length} docs by ID${inaccessibleIds.size > 0 ? `, ${inaccessibleIds.size} inaccessible` : ""}`);
  send({ phase: "metadata", completed: 0, total: docIds.length });
  const driveDocs = await fetchDocsByIds(userId, docIds, (count) => {
    send({ phase: "metadata", completed: count, total: docIds.length });
  });

  let added = 0;
  let updated = 0;
  let deleted = 0;

  // Insert inaccessible docs directly (they can't be fetched from Drive)
  if (loadInaccessibleDocs.length > 0) {
    added += await insertInaccessibleDocs(userId, loadInaccessibleDocs, {
      labelIds: loadLabelIds,
      extraNotes: loadNotes || undefined,
      status: loadStatus,
      isStarred: loadIsStarred,
    });
  }

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

    // Load mode with selection: skip docs not selected by user
    const isSelected = !selectedSet || selectedSet.has(doc.googleDocId);
    if (!isSelected) {
      logInfo(`[Sync]   SKIP ${doc.googleDocId} — not selected by user`);
      continue;
    }

    const result = await prisma.doc.upsert({
      where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
      create: {
        userId,
        googleDocId: doc.googleDocId,
        title: "", // Titles not stored — fetched on demand from Drive API, cached in browser
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        role: doc.role,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        createdTimeInDrive: doc.createdTimeInDrive,
        lastCommentActivity: doc.createdTimeInDrive, // Initialize from creation time; comment sync will bump it up
        status: loadStatus ?? (doc.role === DocRole.AUTHOR ? DocStatus.INBOX : DocStatus.ARCHIVED),
        ...(loadIsStarred !== undefined ? { isStarred: loadIsStarred } : {}),
        ...(loadNotes ? { notes: loadNotes } : {}),
        ...(loadLabelIds.length > 0
          ? { labels: { create: loadLabelIds.map((id) => ({ labelId: id })) } }
          : {}),
      },
      update: {
        title: "", // Clear any previously stored title
        driveUrl: doc.driveUrl,
        mimeType: doc.mimeType,
        lastModifiedInDrive: doc.lastModifiedInDrive,
        createdTimeInDrive: doc.createdTimeInDrive,
        accessState: AccessState.OK,
        ...(loadStatus === DocStatus.INBOX ? { status: DocStatus.INBOX } : {}),
        ...(loadIsStarred !== undefined ? { isStarred: loadIsStarred } : {}),
      },
      select: { docId: true, notes: true },
    });

    // For existing docs in load mode, add labels and append notes
    if (isExisting) {
      if (loadLabelIds.length > 0) {
        await prisma.docLabel.createMany({
          data: loadLabelIds.map((labelId) => ({ docId: result.docId, labelId })),
          skipDuplicates: true,
        });
      }
      if (loadNotes) {
        await prisma.doc.update({
          where: { docId: result.docId },
          data: { notes: appendNotes(result.notes, loadNotes) },
        });
      }
    }

    if (isExisting) {
      logInfo(`[Sync]   UPDATE ${doc.googleDocId} — already tracked, metadata updated`);
      updated++;
    } else {
      logInfo(`[Sync]   ADD ${doc.googleDocId} — new ${doc.role} doc`);
      added++;
    }
  }

  // Sync comments for docs returned by Drive
  const commentDocs = await prisma.doc.findMany({
    where: { userId, accessState: AccessState.OK, googleDocId: { in: [...driveDocIds] } },
  });
  logInfo(`[Sync] Syncing comments for ${commentDocs.length} docs (selected docs)`);

  let syncCompleted = 0;
  let lastProgressTime = 0;
  const syncTotal = commentDocs.length;
  send({ phase: "sync", completed: 0, total: syncTotal });
  let unarchived = 0;
  const parallelismLimit = pLimit(10);
  const syncResults = await Promise.all(
    commentDocs.map((doc) => parallelismLimit(async () => {
      const result = await syncComments(doc, driveAuth, userEmail);
      // Apply DB updates immediately so partial progress is visible on page reload
      if (result.isDeleted) {
        await prisma.doc.update({ where: { docId: doc.docId }, data: { accessState: AccessState.NOT_FOUND } });
        deleted++;
      } else if (doc.status === DocStatus.ARCHIVED && result.shouldUnarchive) {
        await prisma.doc.update({ where: { docId: doc.docId }, data: { status: DocStatus.INBOX } });
        unarchived++;
      }
      syncCompleted++;
      const now = Date.now();
      if (syncCompleted === syncTotal || now - lastProgressTime >= 500) {
        lastProgressTime = now;
        send({ phase: "sync", completed: syncCompleted, total: syncTotal });
      }
      return result;
    }))
  );
  const commentsCreated = syncResults.reduce((sum, r) => sum + r.commentsCreated, 0);
  const commentsUpdated = syncResults.reduce((sum, r) => sum + r.commentsUpdated, 0);
  const suggestionsCreated = syncResults.reduce((sum, r) => sum + r.suggestionsCreated, 0);
  const suggestionsUpdated = syncResults.reduce((sum, r) => sum + r.suggestionsUpdated, 0);

  // Initialize the Drive changes token so subsequent refreshes use changes.list.
  // Safety: if *every* doc failed, skip the token update.
  const successCount = syncResults.filter(r => !r.transientError && !r.permissionDenied && !r.isDeleted).length;
  const allFailed = commentDocs.length > 0 && successCount === 0;
  const transientErrors = syncResults.filter(r => r.transientError).length;

  if (transientErrors === 0 && !allFailed) {
    logInfo("[Sync] Load complete, initializing changes token for future refreshes");
    const token = await getChangesStartPageToken(userId);
    await updateDriveChangesToken(userId, token);
  } else if (allFailed) {
    logWarning(`[Sync] All ${commentDocs.length} document fetches failed, skipping token update for safety`);
  } else {
    logWarning(`[Sync] Transient errors during comment sync for ${transientErrors} docs, skipping token update`);
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
  logInfo(`[Sync] load complete in ${elapsed}ms: ${counts.join(", ")}, ${commentStr}${suggestionStr}`);
  return {
    mode: "load" as const,
    added,
    updated,
    deleted,
    unarchived,
    total: driveDocs.length,
    commentsCreated,
    commentsUpdated,
    suggestionsCreated,
    suggestionsUpdated,
    driveChangesRead: driveDocs.length,
    totalDocuments: driveDocs.length,
  };
}

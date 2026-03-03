import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, fetchDocsByIds, getDriveClient, getChangesStartPageToken, listChanges, invalidGrantResponse } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateDriveChangesToken } from "@/lib/status";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { parseLoadOptions } from "@/lib/load-options";
import { logError, logWarning, logInfo } from "@/lib/log";

export async function GET(req: NextRequest) {
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
}

export async function POST(req: NextRequest) {
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
  if (mode === "load") {
    logInfo(`[Sync] Load options: source=${source}, daysBack=${daysBack}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}${selectedSet ? `, ${selectedSet.size} docs selected` : ""}`);
  }
  const t0 = Date.now();

  let driveDocs: import("@/lib/google-drive").DriveDoc[] = [];
  let deletedDocIds = new Set<string>();
  let driveAuth;
  let newPageToken: string | undefined;

  try {
    driveAuth = await getDriveClient(userId);

    if (mode === "load") {
      // Load mode: fetch metadata directly by selected doc IDs
      const docIds = selectedSet ? [...selectedSet] : [];
      logInfo(`[Sync] Load (${source}): fetching metadata for ${docIds.length} docs by ID`);
      driveDocs = await fetchDocsByIds(userId, docIds);
    } else {
      // Refresh / full-refresh: use changes.list with saved token
      const status = await getStatus(userId);
      const savedToken = status?.driveChangesPageToken;

      if (savedToken) {
        logInfo(`[Sync] ${mode}: using changes.list with saved token`);
        try {
          const result = await listChanges(userId, savedToken);
          driveDocs = result.docs;
          deletedDocIds = result.deletedDocIds;
          newPageToken = result.newPageToken;
          logInfo(`[Sync] changes.list → ${driveDocs.length} changed docs, ${deletedDocIds.size} deletions`);
        } catch (err: unknown) {
          // Expired/invalid token → fall back to bootstrap
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            logWarning("[Sync] changes.list token expired, falling back to bootstrap (7-day files.list)");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId); // default 7-day window
          } else {
            throw err;
          }
        }
      } else {
        // Bootstrap: no saved token — establish baseline and do a 7-day scan
        logInfo(`[Sync] ${mode}: no saved token, bootstrapping (7-day files.list)`);
        newPageToken = await getChangesStartPageToken(userId);
        driveDocs = await listRecentDocs(userId); // default 7-day window
      }
    }
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError("[Sync] Drive error:", err);
    return NextResponse.json(
      { error: "Failed to fetch from Google Drive" },
      { status: 502 }
    );
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

    // Refresh/full-refresh: auto-add new docs I authored; skip others.
    // Shared-with-me docs arrive via gmail-refresh notifications instead.
    if ((mode === "refresh" || mode === "full-refresh") && !isExisting && doc.role !== "AUTHOR") {
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

  // Handle deletions detected by changes.list (refresh/full-refresh)
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

  // Note: deletion detection for existing docs is handled by refresh/full-refresh
  // modes (via changes.list). Load mode only processes the specific docs the user
  // selected, so there's no meaningful "missing from results" set to check.

  // Sync comments: full-refresh syncs ALL docs (including previously deleted
  // ones, so they can recover if a 403 was temporary); refresh syncs only
  // changed docs; load syncs docs returned by Drive
  const commentDocs = mode === "full-refresh"
    ? await prisma.doc.findMany({
        where: { userId },
      })
    : await prisma.doc.findMany({
        where: { userId, isDeleted: false, googleDocId: { in: [...driveDocIds] } },
      });
  logInfo(`[Sync] Syncing comments for ${commentDocs.length} docs (${mode === "full-refresh" ? "all docs" : "changed docs only"})`);
  const syncResults = await Promise.all(
    commentDocs.map((doc) => syncComments(doc, driveAuth, userEmail))
  );
  const comments = syncResults.reduce((sum, r) => sum + r.created, 0);

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
  const anyTransientError = syncResults.some(r => r.transientError);
  if (!anyTransientError) {
    if (newPageToken) {
      logInfo(`[Sync] Saving changes token for future refreshes`);
      await updateDriveChangesToken(userId, newPageToken);
    } else if (mode === "load") {
      logInfo("[Sync] Load complete, initializing changes token for future refreshes");
      const token = await getChangesStartPageToken(userId);
      await updateDriveChangesToken(userId, token);
    }
  } else {
    logWarning("[Sync] Transient errors during comment sync, skipping token update");
  }

  const elapsed = Date.now() - t0;
  logInfo(`[Sync] ${mode} complete in ${elapsed}ms: ${added} added, ${updated} updated, ${deleted} deleted, ${unarchived} unarchived, ${comments} comments synced`);
  return NextResponse.json({ mode, added, updated, deleted, unarchived, total: driveDocs.length, comments });
}

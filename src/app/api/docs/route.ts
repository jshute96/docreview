import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds, getDriveClient, getChangesStartPageToken, listChanges } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateDriveChangesToken } from "@/lib/status";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";

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
      ...(includeArchived ? {} : { status: "ACTIVE" }),
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

  const { searchParams } = new URL(req.url);
  const modeParam = searchParams.get("mode");
  const mode: "refresh" | "full-refresh" | "load" =
    modeParam === "refresh" ? "refresh"
    : modeParam === "full-refresh" ? "full-refresh"
    : "load";

  console.log(`[Sync] Starting ${mode} sync`);
  const t0 = Date.now();

  let driveDocs: import("@/lib/google-drive").DriveDoc[] = [];
  let deletedDocIds = new Set<string>();
  let driveAuth;
  let newPageToken: string | undefined;

  try {
    driveAuth = await getDriveClient(userId);

    if (mode === "load") {
      // Load mode: full 30-day scan via files.list
      console.log("[Sync] Load: scanning via files.list (30-day window)");
      driveDocs = await listRecentDocs(userId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    } else {
      // Refresh / full-refresh: use changes.list with saved token
      const status = await getStatus(userId);
      const savedToken = status?.driveChangesPageToken;

      if (savedToken) {
        console.log(`[Sync] ${mode}: using changes.list with saved token`);
        try {
          const result = await listChanges(userId, savedToken);
          driveDocs = result.docs;
          deletedDocIds = result.deletedDocIds;
          newPageToken = result.newPageToken;
          console.log(`[Sync] changes.list → ${driveDocs.length} changed docs, ${deletedDocIds.size} deletions`);
        } catch (err: unknown) {
          // Expired/invalid token → fall back to bootstrap
          const code = (err as { code?: number | string })?.code;
          if (code === 404 || code === "404") {
            console.warn("[Sync] changes.list token expired, falling back to bootstrap (7-day files.list)");
            newPageToken = await getChangesStartPageToken(userId);
            driveDocs = await listRecentDocs(userId); // default 7-day window
          } else {
            throw err;
          }
        }
      } else {
        // Bootstrap: no saved token — establish baseline and do a 7-day scan
        console.log(`[Sync] ${mode}: no saved token, bootstrapping (7-day files.list)`);
        newPageToken = await getChangesStartPageToken(userId);
        driveDocs = await listRecentDocs(userId); // default 7-day window
      }
    }
  } catch (err) {
    console.error("[Sync] Drive error:", err);
    return NextResponse.json(
      { error: "Failed to fetch from Google Drive" },
      { status: 502 }
    );
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const driveDocIds = new Set(driveDocs.map((d) => d.googleDocId));

  // Pre-fetch existing doc IDs to distinguish adds from updates
  const existingDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId },
      select: { googleDocId: true },
    })).map((d) => d.googleDocId)
  );

  for (const doc of driveDocs) {
    console.log(`[Sync] Doc found: ${doc.title} (${doc.googleDocId})`);
    const isExisting = existingDocIds.has(doc.googleDocId);

    // Refresh/full-refresh: auto-add new docs I authored; skip other new docs
    if ((mode === "refresh" || mode === "full-refresh") && !isExisting && doc.role !== "AUTHOR") continue;

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
      updated++;
    } else {
      added++;
    }
  }

  // Handle deletions detected by changes.list (refresh/full-refresh)
  if (deletedDocIds.size > 0) {
    console.log(`[Sync] Processing ${deletedDocIds.size} deletions from changes.list`);
    const docsToDelete = await prisma.doc.findMany({
      where: {
        userId,
        isDeleted: false,
        googleDocId: { in: [...deletedDocIds] },
      },
      select: { id: true },
    });
    for (const doc of docsToDelete) {
      await prisma.doc.update({ where: { id: doc.id }, data: { isDeleted: true } });
      deleted++;
    }
  }

  // Check active docs that didn't appear in Drive results — only in load mode,
  // since refresh/full-refresh detect deletions via changes.list.
  if (mode === "load") {
    const missingDocs = await prisma.doc.findMany({
      where: {
        userId,
        isDeleted: false,
        status: "ACTIVE",
        googleDocId: { notIn: [...driveDocIds] },
      },
      select: { id: true, googleDocId: true },
    });

    if (missingDocs.length > 0) {
      console.log(`[Sync] Load: checking ${missingDocs.length} docs not in Drive results for deletion`);
      const loadDeletedIds = await findDeletedDocIds(userId, missingDocs.map((d) => d.googleDocId));
      for (const doc of missingDocs) {
        if (loadDeletedIds.has(doc.googleDocId)) {
          await prisma.doc.update({ where: { id: doc.id }, data: { isDeleted: true } });
          deleted++;
        }
      }
    }
  }

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
  console.log(`[Sync] Syncing comments for ${commentDocs.length} docs (${mode === "full-refresh" ? "all docs" : "changed docs only"})`);
  const syncResults = await Promise.all(
    commentDocs.map((doc) => syncComments(doc, driveAuth))
  );
  const comments = syncResults.reduce((sum, r) => sum + r.created, 0);

  // Unarchive ARCHIVED docs only when syncComments detected meaningful new activity.
  // Also handle newly detected deletions from syncComments results.
  let unarchived = 0;
  for (let i = 0; i < commentDocs.length; i++) {
    const res = syncResults[i];
    if (res.isDeleted) {
      await prisma.doc.update({ where: { id: commentDocs[i].id }, data: { isDeleted: true } });
      deleted++;
      continue;
    }
    if (commentDocs[i].status === "ARCHIVED" && res.shouldUnarchive) {
      await prisma.doc.update({ where: { id: commentDocs[i].id }, data: { status: "ACTIVE" } });
      unarchived++;
    }
  }

  // Save changes page token only if no transient errors occurred.
  // For load mode, initialize the token so subsequent refreshes use changes.list.
  const anyTransientError = syncResults.some(r => r.transientError);
  if (!anyTransientError) {
    if (newPageToken) {
      console.log(`[Sync] Saving changes token for future refreshes`);
      await updateDriveChangesToken(userId, newPageToken);
    } else if (mode === "load") {
      console.log("[Sync] Load complete, initializing changes token for future refreshes");
      const token = await getChangesStartPageToken(userId);
      await updateDriveChangesToken(userId, token);
    }
  } else {
    console.warn("[Sync] Transient errors during comment sync, skipping token update");
  }

  const elapsed = Date.now() - t0;
  console.log(`[Sync] ${mode} complete in ${elapsed}ms: ${added} added, ${updated} updated, ${deleted} deleted, ${unarchived} unarchived, ${comments} comments synced`);
  return NextResponse.json({ mode, added, updated, deleted, unarchived, total: driveDocs.length, comments });
}

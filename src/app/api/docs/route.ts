import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds, getDriveClient } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { getStatus, updateDriveTimestamp } from "@/lib/status";
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
  const syncStart = new Date();

  // Refresh and full-refresh use incremental timestamp; load always does a full 30-day scan
  const since = mode === "refresh" || mode === "full-refresh"
    ? (await getStatus(userId))?.lastDriveUpdateTimestamp ?? undefined
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let driveDocs;
  let driveAuth;
  try {
    driveDocs = await listRecentDocs(userId, since);
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    console.error("Drive error:", err);
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

  // Check active docs that didn't appear in Drive results — only in load mode,
  // since refresh/full-refresh use a narrow incremental window where most docs won't appear.
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
      const deletedIds = await findDeletedDocIds(userId, missingDocs.map((d) => d.googleDocId));
      for (const doc of missingDocs) {
        if (deletedIds.has(doc.googleDocId)) {
          await prisma.doc.update({ where: { id: doc.id }, data: { isDeleted: true } });
          deleted++;
        }
      }
    }
  }

  // Sync comments: full-refresh syncs ALL docs (including previously deleted
  // ones, so they can recover if a 403 was temporary); refresh/load only sync
  // docs returned by Drive
  const activeDocs = mode === "full-refresh"
    ? await prisma.doc.findMany({
        where: { userId },
      })
    : await prisma.doc.findMany({
        where: { userId, isDeleted: false, googleDocId: { in: [...driveDocIds] } },
      });
  const syncResults = await Promise.all(
    activeDocs.map((doc) => syncComments(doc, driveAuth))
  );
  const comments = syncResults.reduce((sum, r) => sum + r.created, 0);

  // Unarchive ARCHIVED docs only when syncComments detected meaningful new activity.
  // Also handle newly detected deletions from syncComments results.
  let unarchived = 0;
  for (let i = 0; i < activeDocs.length; i++) {
    const res = syncResults[i];
    if (res.isDeleted) {
      await prisma.doc.update({ where: { id: activeDocs[i].id }, data: { isDeleted: true } });
      deleted++;
      continue;
    }
    if (activeDocs[i].status === "ARCHIVED" && res.shouldUnarchive) {
      await prisma.doc.update({ where: { id: activeDocs[i].id }, data: { status: "ACTIVE" } });
      unarchived++;
    }
  }

  // Save sync timestamp only if all comment syncs succeeded — if any had transient
  // errors, keep the old timestamp so the next refresh re-attempts those docs.
  const anyTransientError = syncResults.some(r => r.transientError);
  if (!anyTransientError) {
    await updateDriveTimestamp(userId, syncStart);
  }

  return NextResponse.json({ mode, added, updated, deleted, unarchived, total: driveDocs.length, comments });
}

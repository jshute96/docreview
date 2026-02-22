import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds, getDriveClient } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "true";
  const labelIds = searchParams.getAll("labelId");

  const docs = await prisma.doc.findMany({
    where: {
      userId,
      ...(includeArchived ? {} : { status: "ACTIVE" }),
      ...(labelIds.length > 0
        ? { labels: { some: { labelId: { in: labelIds } } } }
        : {}),
    },
    include: {
      labels: { include: { label: true } },
      _count: { select: { comments: { where: { status: "ACTIVE" } } } },
    },
    orderBy: { lastModifiedInDrive: "desc" },
  });

  return NextResponse.json(docs);
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let driveDocs;
  let driveAuth;
  try {
    driveDocs = await listRecentDocs(userId);
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

  for (const doc of driveDocs) {
    const existing = await prisma.doc.findUnique({
      where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
    });

    if (existing) {
      const changed =
        existing.title !== doc.title ||
        existing.driveUrl !== doc.driveUrl ||
        existing.mimeType !== doc.mimeType ||
        existing.lastModifiedInDrive?.getTime() !== doc.lastModifiedInDrive?.getTime() ||
        existing.owner !== doc.owner ||
        existing.isDeleted;
      if (changed) {
        await prisma.doc.update({
          where: { id: existing.id },
          data: {
            title: doc.title,
            driveUrl: doc.driveUrl,
            mimeType: doc.mimeType,
            lastModifiedInDrive: doc.lastModifiedInDrive,
            owner: doc.owner,
            createdTimeInDrive: doc.createdTimeInDrive,
            isDeleted: false,
          },
        });
        updated++;
      }
    } else {
      await prisma.doc.create({
        data: {
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
      });
      added++;
    }
  }

  // Check active docs that didn't appear in Drive results — one list call, not N gets
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

  // Sync comments for all non-deleted docs
  const activeDocs = await prisma.doc.findMany({
    where: { userId, isDeleted: false },
  });
  const commentCounts = await Promise.all(
    activeDocs.map((doc) => syncComments(doc, driveAuth))
  );
  const comments = commentCounts.reduce((sum, n) => sum + n, 0);

  return NextResponse.json({ added, updated, deleted, total: driveDocs.length, comments });
}

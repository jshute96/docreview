import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  listRecentDocs,
  findDeletedDocIds,
  fetchComments,
  getDriveClient,
} from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

async function syncComments(
  userId: string,
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>
): Promise<number> {
  let comments;
  try {
    comments = await fetchComments(
      driveAuth,
      doc.googleDocId,
      doc.commentsLastSyncedAt ?? undefined
    );
  } catch (err) {
    console.error(`[Comments] failed for ${doc.googleDocId}:`, err);
    return 0;
  }

  const isFirstSync = doc.commentsLastSyncedAt === null;
  let processed = 0;

  for (const c of comments) {
    const existing = await prisma.comment.findUnique({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: c.id } },
    });

    if (!existing) {
      // New comment: determine initial status
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.create({
        data: {
          docId: doc.id,
          googleCommentId: c.id,
          resolved: c.resolved,
          isMine: c.isMine,
          iParticipated: c.iParticipated,
          status,
        },
      });
      processed++;
    } else {
      // Existing comment returned by startModifiedTime filter — something changed
      if (existing.status === "MUTED") {
        // MUTED is sticky; only update Drive fields
        await prisma.comment.update({
          where: { id: existing.id },
          data: { resolved: c.resolved, iParticipated: c.iParticipated },
        });
        continue;
      }
      let status: string;
      if (c.resolved && c.iResolvedIt) {
        status = "ARCHIVED";
      } else {
        status = "ACTIVE";
      }
      await prisma.comment.update({
        where: { id: existing.id },
        data: {
          resolved: c.resolved,
          iParticipated: c.iParticipated,
          status,
        },
      });
      processed++;
    }
  }

  // Only update commentsLastSyncedAt if we actually queried Drive (even if 0 results)
  await prisma.doc.update({
    where: { id: doc.id },
    data: { commentsLastSyncedAt: new Date() },
  });

  if (!isFirstSync) {
    // On incremental syncs, comments not returned haven't changed — no action needed
  }

  return processed;
}

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
        existing.isDeleted;
      if (changed) {
        await prisma.doc.update({
          where: { id: existing.id },
          data: {
            title: doc.title,
            driveUrl: doc.driveUrl,
            mimeType: doc.mimeType,
            lastModifiedInDrive: doc.lastModifiedInDrive,
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
    activeDocs.map((doc) => syncComments(userId, doc, driveAuth))
  );
  const comments = commentCounts.reduce((sum, n) => sum + n, 0);

  return NextResponse.json({ added, updated, deleted, total: driveDocs.length, comments });
}

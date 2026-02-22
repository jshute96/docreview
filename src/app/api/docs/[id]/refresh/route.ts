import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchComments } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

async function syncComments(
  userId: string,
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>
): Promise<void> {
  let comments;
  try {
    comments = await fetchComments(
      driveAuth,
      doc.googleDocId,
      doc.commentsLastSyncedAt ?? undefined
    );
  } catch (err) {
    console.error(`[Comments] failed for ${doc.googleDocId}:`, err);
    return;
  }

  for (const c of comments) {
    const existing = await prisma.comment.findUnique({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: c.id } },
    });

    if (!existing) {
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.create({
        data: {
          docId: doc.id,
          googleCommentId: c.id,
          resolved: c.resolved,
          isMine: c.isMine,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
    } else {
      if (existing.status === "MUTED") {
        await prisma.comment.update({
          where: { id: existing.id },
          data: {
            resolved: c.resolved,
            iParticipated: c.iParticipated,
            driveCreatedAt: c.driveCreatedAt,
            driveModifiedAt: c.driveModifiedAt,
            replyCount: c.replyCount,
          },
        });
        continue;
      }
      const status = c.resolved && c.iResolvedIt ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.update({
        where: { id: existing.id },
        data: {
          resolved: c.resolved,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
    }
  }

  await prisma.doc.update({
    where: { id: doc.id },
    data: { commentsLastSyncedAt: new Date() },
  });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const doc = await prisma.doc.findUnique({ where: { id } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    console.error("Drive auth error:", err);
    return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
  }

  await syncComments(userId, doc, driveAuth);

  const updated = await prisma.doc.findUnique({
    where: { id },
    include: {
      labels: { include: { label: true } },
      comments: { orderBy: { driveCreatedAt: "asc" } },
    },
  });

  return NextResponse.json(updated);
}

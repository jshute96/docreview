import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { CommentStatus, DocStatus } from "@prisma/client";
import { runWithRequestId } from "@/lib/request-context";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string; commentId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId, commentId } = await params;

  // Verify the comment belongs to a doc owned by this user
  const comment = await prisma.comment.findUnique({
    where: { commentId },
    include: { doc: true },
  });

  if (!comment || comment.doc.userId !== userId || comment.docId !== docId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { status, isRead, isStarred } = body as { status?: CommentStatus; isRead?: boolean; isStarred?: boolean };

  if (status === undefined && isRead === undefined && isStarred === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  if (status !== undefined) {
    const VALID_STATUSES: string[] = Object.values(CommentStatus);
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
  }

  if (isRead !== undefined && typeof isRead !== "boolean") {
    return NextResponse.json({ error: "Invalid isRead" }, { status: 400 });
  }

  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
  }

  // Update comment and (if needed) doc status in a single transaction
  const updated = await prisma.$transaction(async (tx) => {
    const data: { status?: CommentStatus; isRead?: boolean; isStarred?: boolean } = {};
    if (status !== undefined) data.status = status;
    if (isRead !== undefined) data.isRead = isRead;
    if (isStarred !== undefined) data.isStarred = isStarred;

    const result = await tx.comment.update({
      where: { commentId },
      data,
    });

    // Moving a comment to INBOX should also move the doc to INBOX if it's ARCHIVED
    if (status === CommentStatus.INBOX && comment.doc.status === DocStatus.ARCHIVED) {
      await tx.doc.update({
        where: { docId: comment.docId },
        data: { status: DocStatus.INBOX },
      });
    }

    return result;
  });

  return NextResponse.json(updated);
  });
}

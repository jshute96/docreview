import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { CommentStatus } from "@prisma/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string; commentId: string }> }
) {
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
  const { status } = body as { status: CommentStatus };

  const VALID_STATUSES: string[] = Object.values(CommentStatus);
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Update comment and (if needed) doc status in a single transaction
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.comment.update({
      where: { commentId },
      data: { status },
    });

    // Moving a comment to INBOX should also move the doc to INBOX if it's ARCHIVED
    if (status === "INBOX" && comment.doc.status === "ARCHIVED") {
      await tx.doc.update({
        where: { docId: comment.docId },
        data: { status: "INBOX" },
      });
    }

    return result;
  });

  return NextResponse.json(updated);
}

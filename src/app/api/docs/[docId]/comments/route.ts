import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { CommentStatus, Prisma } from "@prisma/client";
import { runWithRequestId } from "@/lib/request-context";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId } = await params;

  // Verify the doc belongs to this user
  const doc = await prisma.doc.findUnique({ where: { docId } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { commentIds, status, isRead } = body as { commentIds: string[]; status?: CommentStatus; isRead?: boolean };

  // Element types are checked too: a non-string would otherwise reach
  // Prisma.join / updateMany's `in` and surface as a 500 instead of a 400.
  if (!Array.isArray(commentIds) || commentIds.length === 0 ||
      !commentIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "Invalid commentIds" }, { status: 400 });
  }

  // Must provide exactly one of status or isRead
  if (status !== undefined && isRead !== undefined) {
    return NextResponse.json({ error: "Provide status or isRead, not both" }, { status: 400 });
  }

  if (status !== undefined) {
    const VALID_STATUSES: string[] = Object.values(CommentStatus);
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
  } else if (typeof isRead !== "boolean") {
    return NextResponse.json({ error: "Invalid isRead value" }, { status: 400 });
  }

  // Update only comments that belong to this document
  let count: number;
  if (status !== undefined) {
    const result = await prisma.comment.updateMany({
      where: { commentId: { in: commentIds }, docId },
      data: { status },
    });
    count = result.count;
  } else if (isRead) {
    // "Read" means every known message: reply_count + 1 (see
    // src/lib/read-state.ts). That's a cross-column assignment, which Prisma's
    // updateMany can't express, so it goes through raw SQL. commentIds is
    // validated non-empty above, which Prisma.join requires. `updated_at` is
    // set explicitly because Prisma maintains @updatedAt in the client, not the
    // database — raw SQL would otherwise leave it stale here while every other
    // comment write bumps it.
    count = await prisma.$executeRaw`
      UPDATE comments SET read_message_count = reply_count + 1, updated_at = NOW()
      WHERE doc_id = ${docId} AND comment_id IN (${Prisma.join(commentIds)})
    `;
  } else {
    const result = await prisma.comment.updateMany({
      where: { commentId: { in: commentIds }, docId },
      data: { readMessageCount: 0 },
    });
    count = result.count;
  }

  return NextResponse.json({ count });
  });
}

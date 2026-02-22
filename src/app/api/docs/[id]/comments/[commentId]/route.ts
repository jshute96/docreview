import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id, commentId } = await params;

  // Verify the comment belongs to a doc owned by this user
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { doc: true },
  });

  if (!comment || comment.doc.userId !== userId || comment.docId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { status } = body as { status: "ACTIVE" | "ARCHIVED" | "MUTED" };

  const VALID_STATUSES = ["ACTIVE", "ARCHIVED", "MUTED"];
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const updated = await prisma.comment.update({
    where: { id: commentId },
    data: { status },
  });

  return NextResponse.json(updated);
}

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchCommentContent } from "@/lib/google-drive";

export async function GET(
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

  const driveAuth = await getDriveClient(userId);
  const content = await fetchCommentContent(driveAuth, doc.googleDocId);
  return NextResponse.json(content);
}

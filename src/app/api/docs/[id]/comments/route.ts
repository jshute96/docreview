import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchAllThreads, invalidGrantResponse } from "@/lib/google-drive";
import type { CommentThread } from "@/lib/google-drive";
import { CommentStatus } from "@prisma/client";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getValidSession();
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
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const message = err instanceof Error ? err.message : "Failed to connect to Google Drive";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    const allThreads = await fetchAllThreads(driveAuth, doc.googleDocId);

    const threads: Record<string, CommentThread> = {};
    for (const t of allThreads) {
      threads[t.id] = t;
    }

    return NextResponse.json({ threads });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const message = err instanceof Error ? err.message : "Failed to fetch comment threads";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id: docId } = await params;

  // Verify the doc belongs to this user
  const doc = await prisma.doc.findUnique({ where: { id: docId } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { commentIds, status } = body as { commentIds: string[]; status: CommentStatus };

  if (!Array.isArray(commentIds) || commentIds.length === 0) {
    return NextResponse.json({ error: "Invalid commentIds" }, { status: 400 });
  }

  const VALID_STATUSES: string[] = Object.values(CommentStatus);
  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Update only comments that belong to this document
  const result = await prisma.comment.updateMany({
    where: {
      id: { in: commentIds },
      docId,
    },
    data: { status },
  });

  return NextResponse.json({ count: result.count });
}

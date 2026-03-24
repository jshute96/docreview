import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, fetchCommentData, invalidGrantResponse } from "@/lib/google-drive";
import type { CommentThread } from "@/lib/google-drive";
import { CommentStatus } from "@prisma/client";
import { runWithRequestId } from "@/lib/request-context";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("GET", _req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId } = await params;

  const doc = await prisma.doc.findUnique({ where: { docId } });
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
    const drive = createDriveService(driveAuth);
    const [threadResult, fileRes] = await Promise.all([
      fetchCommentData(driveAuth, doc.googleDocId, { threads: true }),
      drive.files.get({
        fileId: doc.googleDocId,
        fields: "viewedByMeTime",
        supportsAllDrives: true,
      }),
    ]);

    const threads: Record<string, CommentThread> = {};
    for (const t of threadResult.threads ?? []) {
      threads[t.id] = t;
    }

    return NextResponse.json({
      threads,
      viewedByMeTime: fileRes.data.viewedByMeTime ?? null,
    });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const message = err instanceof Error ? err.message : "Failed to fetch comment threads";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  });
}

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

  if (!Array.isArray(commentIds) || commentIds.length === 0) {
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

  const data: { status?: CommentStatus; isRead?: boolean } = {};
  if (status !== undefined) data.status = status;
  if (isRead !== undefined) data.isRead = isRead;

  // Update only comments that belong to this document
  const result = await prisma.comment.updateMany({
    where: {
      commentId: { in: commentIds },
      docId,
    },
    data,
  });

  return NextResponse.json({ count: result.count });
  });
}

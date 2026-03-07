import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  replyToComment,
  fetchThreadDetail,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { logError, logInfo } from "@/lib/log";
import { formatDate } from "@/lib/utils";
import { runWithRequestId } from "@/lib/request-context";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", req, async () => {
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

  const body = await req.json();
  const { commentId, content, resolve } = body as {
    commentId: string;
    content?: string;
    resolve?: boolean;
  };

  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }

  const commentRecord = await prisma.comment.findFirst({
    where: { docId, googleCommentId: commentId },
  });
  if (!commentRecord) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  try {
    const driveAuth = await getDriveClient(userId);
    const drive = createDriveService(driveAuth);

    const trimmed = content?.trim() || "";

    // Pin viewedByMeTime: read before, do the action, restore after
    const getViewed = async () => {
      const r = await drive.files.get({ fileId: doc.googleDocId, fields: "viewedByMeTime" });
      return r.data.viewedByMeTime ?? null;
    };

    const fmt = (t: string | null) => t ? formatDate(t) : "null";

    const viewedBefore = await getViewed();
    logInfo(`[ViewedPin] Before reply/resolve: viewedByMeTime=${fmt(viewedBefore)} (doc=${doc.googleDocId}, comment=${commentId})`);

    // Single API call handles reply, resolve, or both
    if (trimmed || resolve) {
      await replyToComment(driveAuth, doc.googleDocId, commentId, trimmed, resolve);
    }

    const viewedAfter = await getViewed();
    logInfo(`[ViewedPin] After reply/resolve: viewedByMeTime=${fmt(viewedAfter)} (was ${fmt(viewedBefore)})`);

    if (viewedBefore) {
      await drive.files.update({
        fileId: doc.googleDocId,
        requestBody: { viewedByMeTime: viewedBefore },
        fields: "viewedByMeTime",
      });
      logInfo(`[ViewedPin] Restored viewedByMeTime to ${fmt(viewedBefore)}`);

      const viewedRestored = await getViewed();
      logInfo(`[ViewedPin] Verified after restore: viewedByMeTime=${fmt(viewedRestored)}`);
    }

    // Refresh thread data from Drive
    const data = await fetchThreadDetail(driveAuth, doc.googleDocId, commentId);
    if (!data) {
      return NextResponse.json({ error: "Comment not found in Drive" }, { status: 404 });
    }

    const isMuted = commentRecord.status === "MUTED";
    const status = isMuted
      ? commentRecord.status
      : data.resolved && data.iResolvedIt
        ? "ARCHIVED"
        : "INBOX";

    const updated = await prisma.comment.update({
      where: { commentId: commentRecord.commentId },
      data: {
        resolved: data.resolved,
        isThreadAuthor: data.isThreadAuthor,
        iParticipated: data.iParticipated,
        isRead: data.isRead,
        ...(isMuted ? {} : { status }),
        driveCreatedAt: data.driveCreatedAt,
        driveModifiedAt: data.driveModifiedAt,
        replyCount: data.replyCount,
      },
    });

    return NextResponse.json({ comment: updated, threads: [data.thread] });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError(`[API] Failed to reply/resolve comment ${commentId} for doc ${docId}:`, err);
    return NextResponse.json(
      { error: "Failed to reply/resolve comment" },
      { status: 502 }
    );
  }
  });
}

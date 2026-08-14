import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  replyToComment,
  withViewedTimePinned,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { syncSingleComment } from "@/lib/sync-comments";
import { logError } from "@/lib/log";
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

  // Look up by googleCommentId (comments) or googleSuggestionId (suggestions)
  const commentRecord = await prisma.comment.findFirst({
    where: {
      docId,
      OR: [
        { googleCommentId: commentId },
        { googleSuggestionId: commentId },
      ],
    },
  });
  if (!commentRecord) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }

  try {
    const driveAuth = await getDriveClient(userId);

    const trimmed = content?.trim() || "";

    // Single API call handles reply, resolve, or both
    if (trimmed || resolve) {
      await withViewedTimePinned(driveAuth, doc.googleDocId, `reply/resolve comment=${commentId}`, () =>
        replyToComment(driveAuth, doc.googleDocId, commentId, trimmed, resolve)
      );
    }

    // Refresh thread data from Drive using shared single-comment sync
    const userEmail = session.user.email ?? undefined;
    const syncResult = await syncSingleComment(doc, commentId, driveAuth, { userEmail, expectRecentComment: true });
    if (!syncResult.comment) {
      return NextResponse.json({ error: "Comment not found in Drive" }, { status: 404 });
    }

    return NextResponse.json({
      comment: syncResult.comment,
      threads: syncResult.thread ? { [syncResult.thread.id]: syncResult.thread } : {},
    });
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

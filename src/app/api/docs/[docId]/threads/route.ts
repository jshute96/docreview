import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { google } from "googleapis";
import { getDriveClient, fetchThreadDetail, fetchSuggestions, fetchAllThreads, invalidGrantResponse } from "@/lib/google-drive";
import { logError } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId(`GET ${req.nextUrl.pathname}`, async () => {
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

  const commentId = req.nextUrl.searchParams.get("commentId");
  const checkOnly = req.nextUrl.searchParams.get("checkOnly") === "true";

  try {
    const driveAuth = await getDriveClient(userId);

    if (commentId && checkOnly) {
      const drive = google.drive({ version: "v3", auth: driveAuth });
      const commentRes = await drive.comments.get({
        fileId: doc.googleDocId,
        commentId,
        fields: "modifiedTime",
      });
      return NextResponse.json({ modifiedTime: commentRes.data.modifiedTime });
    }

    if (commentId) {
      const data = await fetchThreadDetail(driveAuth, doc.googleDocId, commentId);
      return NextResponse.json({ threads: data ? [data.thread] : [] });
    }

    const threads = await fetchAllThreads(driveAuth, doc.googleDocId);
    return NextResponse.json({ threads });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError(`[API] Failed to fetch threads for doc ${docId}:`, err);
    return NextResponse.json(
      { error: "Failed to fetch comment threads from Drive" },
      { status: 502 }
    );
  }
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId(`POST ${req.nextUrl.pathname}`, async () => {
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

  const commentId = req.nextUrl.searchParams.get("commentId");
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

    // Suggestions live in the Docs API, not Drive comments
    if (commentRecord.type === "SUGGESTION") {
      if (doc.mimeType !== DOCS_MIME_TYPE) {
        return NextResponse.json({ comment: commentRecord, threads: [] });
      }
      const liveSuggestions = await fetchSuggestions(driveAuth, doc.googleDocId);
      const stillLive = liveSuggestions.some((s) => s.id === commentRecord.googleCommentId);

      if (!stillLive && !commentRecord.resolved) {
        const updated = await prisma.comment.update({
          where: { commentId: commentRecord.commentId },
          data: {
            resolved: true,
            status: commentRecord.status === "MUTED" ? commentRecord.status : "ARCHIVED",
          },
        });
        return NextResponse.json({ comment: updated, threads: [] });
      }

      return NextResponse.json({ comment: commentRecord, threads: [] });
    }

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
    logError(`[API] Failed to refresh comment ${commentId} for doc ${docId}:`, err);
    return NextResponse.json(
      { error: "Failed to refresh comment from Drive" },
      { status: 502 }
    );
  }
  });
}

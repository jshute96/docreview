import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, fetchThreadDetail, fetchDocData, fetchCommentData, invalidGrantResponse, isDriveErrorCode, getDriveErrorCode } from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";
import type { ThreadMap } from "@/lib/google-drive";
import { bumpLastCommentActivity, syncSingleComment } from "@/lib/sync-comments";
import { logError, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { GoogleMimeType } from "@/lib/mime-types";
import { CommentStatus, CommentType } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("GET", req, async () => {
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
      const drive = createDriveService(driveAuth);
      try {
        const commentRes = await drive.comments.get({
          fileId: doc.googleDocId,
          commentId,
          fields: "modifiedTime",
        });
        return NextResponse.json({ modifiedTime: commentRes.data.modifiedTime });
      } catch (err) {
        if (isDriveErrorCode(err, 404)) {
          return NextResponse.json({ modifiedTime: null });
        }
        if (isDriveErrorCode(err, 403)) {
          return NextResponse.json({ modifiedTime: null, forbidden: true });
        }
        throw err;
      }
    }

    if (commentId) {
      let data;
      try {
        data = await fetchThreadDetail(driveAuth, doc.googleDocId, commentId, session.user.email ?? undefined);
      } catch (err) {
        if (isDriveErrorCode(err, 404)) {
          // Comment was deleted — return empty threads so the UI updates cleanly
          return NextResponse.json({ threads: {} });
        }
        if (isDriveErrorCode(err, 403)) {
          return NextResponse.json({ threads: {}, forbidden: true });
        }
        throw err;
      }
      const threads: ThreadMap = {};
      if (data?.thread) threads[data.thread.id] = data.thread;
      return NextResponse.json({ threads });
    }

    // Full thread list: fetch all threads + viewedByMeTime in parallel
    const drive = createDriveService(driveAuth);
    const [threadResult, fileRes] = await Promise.all([
      fetchCommentData(driveAuth, doc.googleDocId, { threads: true }),
      drive.files.get({
        fileId: doc.googleDocId,
        fields: "viewedByMeTime",
        supportsAllDrives: true,
      }),
    ]);

    const threads: ThreadMap = {};
    for (const t of threadResult.threads ?? []) {
      threads[t.id] = t;
    }

    return NextResponse.json({
      threads,
      viewedByMeTime: fileRes.data.viewedByMeTime ?? null,
      // comments.list can be refused while files.get succeeds — the doc is
      // readable, its comments aren't. Without this the UI would show the
      // ordinary "no comments" empty state.
      ...(threadResult.permissionDenied ? { forbidden: true } : {}),
    });
  } catch (err) {
    if (err instanceof OfflineModeError) {
      logWarning(`[API] Offline mode — skipping Drive thread fetch for doc ${docId}`);
      return NextResponse.json({ threads: {} });
    }
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    // 403 Forbidden — user doesn't have comment access to this doc.
    // 404 is ambiguous: the file was deleted, or Drive is hiding it because
    // access was revoked. Either way the threads aren't reachable, so report it
    // the same way rather than logging an error and returning a 502.
    const code = getDriveErrorCode(err);
    if (code === 403 || code === 404) {
      logWarning(`[API] Comments unavailable for doc ${docId} (code ${code})`);
      return NextResponse.json({ threads: {}, forbidden: true });
    }
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

  const commentId = req.nextUrl.searchParams.get("commentId");
  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }

  // Determine whether this is a comment or suggestion
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

    // Suggestions live in the Docs API, not Drive comments
    if (commentRecord.type === CommentType.SUGGESTION) {
      if (doc.mimeType !== GoogleMimeType.Doc) {
        return NextResponse.json({ comment: commentRecord, threads: {} });
      }
      const docData = await fetchDocData(driveAuth, doc.googleDocId);
      const liveSuggestions = docData.suggestions;
      const stillLive = liveSuggestions.some((s) => s.id === commentRecord.googleSuggestionId);

      if (!stillLive && !commentRecord.resolved) {
        const now = new Date();
        const updated = await prisma.$transaction(async (tx) => {
          const result = await tx.comment.update({
            where: { commentId: commentRecord.commentId },
            data: {
              resolved: true,
              status: commentRecord.status === CommentStatus.MUTED ? commentRecord.status : CommentStatus.ARCHIVED,
            },
          });
          await bumpLastCommentActivity(doc.docId, [now], tx);
          return result;
        });
        return NextResponse.json({ comment: updated, threads: {} });
      }

      return NextResponse.json({ comment: commentRecord, threads: {} });
    }

    // Comments: use syncSingleComment for targeted fetch + DB update
    const userEmail = session.user.email ?? undefined;
    const result = await syncSingleComment(doc, commentId, driveAuth, { userEmail });
    if (result.permissionDenied) {
      // Comment access was revoked. This has to be an error status, not an empty
      // 200: the client replaces its thread state with whatever comes back, so a
      // 200 would silently erase the thread it is showing.
      return NextResponse.json(
        { error: "Comments are no longer visible on this document." },
        { status: 403 }
      );
    }
    if (!result.comment) {
      return NextResponse.json({ error: "Comment not found in Drive" }, { status: 404 });
    }

    return NextResponse.json({
      comment: result.comment,
      threads: result.thread ? { [result.thread.id]: result.thread } : {},
    });
  } catch (err) {
    if (err instanceof OfflineModeError) {
      logWarning(`[API] Offline mode — skipping Drive comment refresh for ${commentId}`);
      return NextResponse.json({ comment: commentRecord, threads: {} });
    }
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

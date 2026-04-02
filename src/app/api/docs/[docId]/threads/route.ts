import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, fetchThreadDetail, fetchDocData, fetchCommentData, invalidGrantResponse } from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";
import type { ThreadMap } from "@/lib/google-drive";
import { bumpLastCommentActivity, syncSingleComment } from "@/lib/sync-comments";
import { logError, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

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
      } catch (err: any) {
        if (err.code === 404) {
          return NextResponse.json({ modifiedTime: null });
        }
        throw err;
      }
    }

    if (commentId) {
      let data;
      try {
        data = await fetchThreadDetail(driveAuth, doc.googleDocId, commentId, session.user.email ?? undefined);
      } catch (err: any) {
        if (err.code === 404) {
          // Comment was deleted — return empty threads so the UI updates cleanly
          return NextResponse.json({ threads: {} });
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
    });
  } catch (err) {
    if (err instanceof OfflineModeError) {
      logWarning(`[API] Offline mode — skipping Drive thread fetch for doc ${docId}`);
      return NextResponse.json({ threads: {} });
    }
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
    if (commentRecord.type === "SUGGESTION") {
      if (doc.mimeType !== DOCS_MIME_TYPE) {
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
              status: commentRecord.status === "MUTED" ? commentRecord.status : "ARCHIVED",
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

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  replyToComment,
  withViewedTimePinned,
  invalidGrantResponse,
  isDriveErrorCode,
} from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";
import { syncSingleComment } from "@/lib/sync-comments";
import { logError, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

/** Thrown when the reply landed but reading it back didn't, so the failure is
 *  never reported as though the reply hadn't been posted. */
class PostWriteError extends Error {
  constructor(readonly cause: unknown) {
    super("post-write sync failed");
  }
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

  // Set once the reply/resolve itself lands. Everything after that point —
  // restoring viewedByMeTime, re-reading the thread — must never be reported as
  // "failed", or the user will post the same reply twice.
  let writeLanded = false;

  try {
    const driveAuth = await getDriveClient(userId);

    const trimmed = content?.trim() || "";

    // Single API call handles reply, resolve, or both
    if (trimmed || resolve) {
      await withViewedTimePinned(driveAuth, doc.googleDocId, `reply/resolve comment=${commentId}`, async () => {
        const result = await replyToComment(driveAuth, doc.googleDocId, commentId, trimmed, resolve);
        writeLanded = true;
        return result;
      });
    }

    // Refresh thread data from Drive using shared single-comment sync
    const userEmail = session.user.email ?? undefined;
    const syncResult = await syncSingleComment(doc, commentId, driveAuth, { userEmail, expectRecentComment: true });
    if (syncResult.permissionDenied) {
      throw new PostWriteError(new Error("comment access denied (403)"));
    }
    if (!syncResult.comment) {
      return NextResponse.json({ error: "Comment not found in Drive" }, { status: 404 });
    }

    return NextResponse.json({
      comment: syncResult.comment,
      threads: syncResult.thread ? { [syncResult.thread.id]: syncResult.thread } : {},
    });
  } catch (err) {
    if (err instanceof OfflineModeError) {
      return NextResponse.json(
        { error: "Offline mode — replies can't be posted." },
        { status: 503 }
      );
    }
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    if (err instanceof PostWriteError || writeLanded) {
      // The reply is already in the document — saying "failed" would invite the
      // user to post it again. Same contract as the edit route.
      logError(`[API] reply/resolve of ${commentId} succeeded but re-reading it failed (doc ${docId}):`, err instanceof PostWriteError ? err.cause : err);
      return NextResponse.json(
        { error: "Your reply was posted, but Docreview couldn't re-read the thread. Refresh to see it." },
        { status: 502 }
      );
    }
    // Match the edit/delete route: Drive's own refusals get real statuses and
    // messages instead of a blanket 502 (see threads/edit/route.ts).
    if (isDriveErrorCode(err, 403)) {
      logWarning(`[API] Drive refused reply/resolve of comment ${commentId} on doc ${docId} (code 403)`);
      return NextResponse.json(
        { error: "You don't have permission to comment on this document." },
        { status: 403 }
      );
    }
    if (isDriveErrorCode(err, 404)) {
      logWarning(`[API] Comment ${commentId} no longer exists on doc ${docId} (code 404)`);
      return NextResponse.json(
        { error: "This comment no longer exists in the document." },
        { status: 404 }
      );
    }
    logError(`[API] Failed to reply/resolve comment ${commentId} for doc ${docId}:`, err);
    return NextResponse.json(
      { error: "Failed to reply/resolve comment" },
      { status: 502 }
    );
  }
  });
}

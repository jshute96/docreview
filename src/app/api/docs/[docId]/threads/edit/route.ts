/**
 * Edit and delete comments and replies on a doc, via the Drive API.
 *
 * PATCH  { commentId, replyId?, content }  — edit a comment or one of its replies
 * DELETE { commentId, replyId? }           — delete a reply, or the whole thread
 *
 * Drive only permits these on entries authored by the signed-in user; anything
 * else returns 403, which is surfaced as a 403 here rather than a generic 502.
 * Suggestions are rejected — the Docs API has no edit/delete for them (see
 * docs/suggestions.md).
 */
import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  editComment,
  editReply,
  deleteComment,
  deleteReply,
  withViewedTimePinned,
  invalidGrantResponse,
  isDriveErrorCode,
} from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";
import { syncSingleComment, bumpLastCommentActivity } from "@/lib/sync-comments";
import { logError, logInfo, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { CommentType } from "@prisma/client";

interface EditBody {
  commentId?: string;
  replyId?: string;
  content?: string;
}

/** Shared setup for both handlers: auth, doc ownership, comment lookup. */
async function resolveTarget(req: NextRequest, docId: string) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const userId = session.user.id;

  const doc = await prisma.doc.findUnique({ where: { docId } });
  if (!doc || doc.userId !== userId) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  let body: EditBody;
  try {
    body = (await req.json()) as EditBody;
  } catch {
    return { error: NextResponse.json({ error: "Invalid request body" }, { status: 400 }) };
  }
  const { commentId, replyId } = body;
  if (!commentId) {
    return { error: NextResponse.json({ error: "commentId required" }, { status: 400 }) };
  }

  const record = await prisma.comment.findFirst({
    where: {
      docId,
      OR: [{ googleCommentId: commentId }, { googleSuggestionId: commentId }],
    },
  });
  if (!record) {
    return { error: NextResponse.json({ error: "Comment not found" }, { status: 404 }) };
  }
  if (record.type === CommentType.SUGGESTION) {
    return {
      error: NextResponse.json(
        { error: "Suggestions can't be edited or deleted from Docreview" },
        { status: 400 }
      ),
    };
  }

  return {
    error: null,
    userId,
    userEmail: session.user.email ?? undefined,
    doc,
    record,
    commentId,
    replyId,
    body,
  };
}

/** Thrown when the Drive write succeeded but reading the result back didn't, so
 *  the failure is never reported as though the change hadn't been made. */
class PostWriteError extends Error {
  constructor(readonly cause: unknown) {
    super("post-write sync failed");
  }
}

/** Maps Drive write failures to useful statuses instead of a blanket 502. */
function writeErrorResponse(
  err: unknown,
  action: "edit" | "delete",
  entity: "comment" | "reply",
  docId: string,
  commentId: string
) {
  if (err instanceof PostWriteError) {
    // The document already changed — saying "failed" would invite the user to
    // repeat a write that landed.
    logError(`[API] ${action} of ${entity} ${commentId} succeeded but re-sync failed (doc ${docId}):`, err.cause);
    return NextResponse.json(
      { error: `Your ${action} was saved, but Docreview couldn't re-read the thread. Refresh to see it.` },
      { status: 502 }
    );
  }
  if (err instanceof OfflineModeError) {
    return NextResponse.json(
      { error: "Offline mode — comments can't be edited or deleted." },
      { status: 503 }
    );
  }
  const reauth = invalidGrantResponse(err);
  if (reauth) return reauth;
  if (isDriveErrorCode(err, 403)) {
    // The UI only offers these on your own entries, so Drive disagreeing is
    // worth seeing in the logs.
    logWarning(`[API] Drive refused ${action} of ${entity} ${commentId} on doc ${docId} — not the author`);
    return NextResponse.json(
      { error: `You can only edit or delete your own ${entity === "reply" ? "replies" : "comments"}.` },
      { status: 403 }
    );
  }
  if (isDriveErrorCode(err, 404)) {
    return NextResponse.json(
      { error: `This ${entity} no longer exists in the document.` },
      { status: 404 }
    );
  }
  logError(`[API] Failed to ${action} ${entity} ${commentId} for doc ${docId}:`, err);
  return NextResponse.json({ error: `Failed to ${action} ${entity}` }, { status: 502 });
}

/** Re-reads a thread after a successful write, tagging any failure so it isn't
 *  mistaken for the write itself failing. */
async function resyncAfterWrite(
  ...args: Parameters<typeof syncSingleComment>
): Promise<Awaited<ReturnType<typeof syncSingleComment>>> {
  try {
    return await syncSingleComment(...args);
  } catch (err) {
    throw new PostWriteError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
    const { docId } = await params;
    const target = await resolveTarget(req, docId);
    if (target.error) return target.error;
    const { doc, userId, userEmail, commentId, replyId, body } = target;

    const content = body.content?.trim();
    if (!content) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }

    try {
      const driveAuth = await getDriveClient(userId);
      const label = replyId ? `edit reply=${replyId}` : `edit comment=${commentId}`;
      await withViewedTimePinned(driveAuth, doc.googleDocId, label, () =>
        replyId
          ? editReply(driveAuth, doc.googleDocId, commentId, replyId, content)
          : editComment(driveAuth, doc.googleDocId, commentId, content)
      );

      // Re-read from Drive so the client renders the stored content, not the
      // text it optimistically typed (Drive may normalize it).
      // selfEdited: this bumps Drive's modifiedTime, but the user's own edit is
      // not activity that should move the comment back to their Inbox.
      const result = await resyncAfterWrite(doc, commentId, driveAuth, {
        userEmail,
        expectRecentComment: true,
        selfEdited: true,
      });
      if (!result.comment) {
        // The entry was edited but the thread vanished between the two calls.
        throw new PostWriteError(new Error("comment missing from Drive after edit"));
      }
      return NextResponse.json({
        comment: result.comment,
        threads: result.thread ? { [result.thread.id]: result.thread } : {},
      });
    } catch (err) {
      return writeErrorResponse(err, "edit", replyId ? "reply" : "comment", docId, commentId);
    }
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("DELETE", req, async () => {
    const { docId } = await params;
    const target = await resolveTarget(req, docId);
    if (target.error) return target.error;
    const { doc, userId, userEmail, record, commentId, replyId } = target;

    try {
      const driveAuth = await getDriveClient(userId);
      const label = replyId ? `delete reply=${replyId}` : `delete comment=${commentId}`;
      await withViewedTimePinned(driveAuth, doc.googleDocId, label, () =>
        replyId
          ? deleteReply(driveAuth, doc.googleDocId, commentId, replyId)
          : deleteComment(driveAuth, doc.googleDocId, commentId)
      );

      // Deleting a reply leaves the thread — re-sync it so replyCount and the
      // derived status flags follow. Deleting the comment removes the thread,
      // so drop our record instead of syncing a thread that no longer exists.
      if (replyId) {
        const result = await resyncAfterWrite(doc, commentId, driveAuth, {
          userEmail,
          expectRecentComment: true,
          selfEdited: true,
        });
        return NextResponse.json({
          comment: result.comment,
          threads: result.thread ? { [result.thread.id]: result.thread } : {},
          deleted: result.deleted,
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.comment.delete({ where: { commentId: record.commentId } });
        await bumpLastCommentActivity(doc.docId, [new Date()], tx);
      });
      logInfo(`[Comments] ${doc.googleDocId}: deleted comment thread ${commentId}`);
      return NextResponse.json({ deleted: true });
    } catch (err) {
      return writeErrorResponse(err, "delete", replyId ? "reply" : "comment", docId, commentId);
    }
  });
}

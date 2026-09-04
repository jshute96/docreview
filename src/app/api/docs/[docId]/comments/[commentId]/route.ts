import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { CommentStatus, DocStatus } from "@prisma/client";
import { runWithRequestId } from "@/lib/request-context";
import { totalMessageCount, totalSlotCount } from "@/lib/read-state";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string; commentId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId, commentId } = await params;

  // Verify the comment belongs to a doc owned by this user
  const comment = await prisma.comment.findUnique({
    where: { commentId },
    include: { doc: true },
  });

  if (!comment || comment.doc.userId !== userId || comment.docId !== docId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { status, isRead, isStarred, readSlotCount, readMessageCount } = body as {
    status?: CommentStatus;
    isRead?: boolean;
    isStarred?: boolean;
    readSlotCount?: number;
    readMessageCount?: number;
  };

  if (status === undefined && isRead === undefined && isStarred === undefined
      && readSlotCount === undefined && readMessageCount === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  if (status !== undefined) {
    const VALID_STATUSES: string[] = Object.values(CommentStatus);
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
  }

  if (isRead !== undefined && typeof isRead !== "boolean") {
    return NextResponse.json({ error: "Invalid isRead" }, { status: 400 });
  }

  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
  }

  // Both write the read boundary, so accepting them together would raise a
  // precedence question with no good answer.
  if (isRead !== undefined && readSlotCount !== undefined) {
    return NextResponse.json(
      { error: "Send either isRead or readSlotCount, not both" },
      { status: 400 }
    );
  }

  if (readSlotCount !== undefined && (!Number.isInteger(readSlotCount) || readSlotCount < 0)) {
    return NextResponse.json({ error: "Invalid readSlotCount" }, { status: 400 });
  }

  // The two read counts travel together, in both directions: they're the same
  // boundary in the two numbering spaces, and this route can't convert between
  // them — that needs the thread's tombstones, which only the client has. So a
  // boundary without its render-space twin is rejected rather than guessed at.
  if ((readSlotCount === undefined) !== (readMessageCount === undefined)) {
    return NextResponse.json(
      { error: "readSlotCount and readMessageCount must be sent together" },
      { status: 400 }
    );
  }
  if (readMessageCount !== undefined
      && (!Number.isInteger(readMessageCount) || readMessageCount < 0)) {
    return NextResponse.json({ error: "Invalid readMessageCount" }, { status: 400 });
  }
  // The one relation between the two that holds without knowing the tombstones:
  // the live messages below a boundary are a subset of the slots below it, so the
  // render count can never exceed the slot count. A pair that breaks this is a
  // client bug, and storing it would leave the row claiming more messages read
  // than slots read until the next sync recomputed it.
  if (readSlotCount !== undefined && readMessageCount! > readSlotCount) {
    return NextResponse.json(
      { error: "readMessageCount cannot exceed readSlotCount" },
      { status: 400 }
    );
  }

  // Update comment and (if needed) doc status in a single transaction
  const updated = await prisma.$transaction(async (tx) => {
    const data: {
      status?: CommentStatus;
      readSlotCount?: number;
      readMessageCount?: number;
      isStarred?: boolean;
    } = {};
    if (status !== undefined) data.status = status;
    // `isRead` is the whole-thread form: "read" means every known message (see
    // src/lib/read-state.ts). The reply count is the one the DB knew about at
    // click time, which may lag the thread if it hasn't been synced. Replies
    // discovered later land above the stored count and correctly show as unread.
    if (isRead !== undefined) {
      data.readSlotCount = isRead ? totalSlotCount(comment.replySlotCount) : 0;
      data.readMessageCount = isRead ? totalMessageCount(comment.replyCount) : 0;
    }
    // `readSlotCount` is the per-message form, sent by the thread panel's
    // read-point controls as an absolute slot index — the client converts the
    // position it drew using the tombstones in the thread it fetched, and sends
    // both numbers. Clamped so the stored boundary can never exceed the thread
    // it belongs to.
    //
    // The panel counts messages from the thread it fetched, which can hold
    // replies `replySlotCount` hasn't caught up with, so the client syncs the thread
    // first whenever it's about to send a count past the stored size — by the
    // time the write lands, the clamp is against a current count rather than a
    // stale one. It only bites when that sync couldn't run or didn't help, and
    // the client tells the user when the stored count comes back lower than
    // asked. Rejecting instead would lose a click the user meant.
    if (readSlotCount !== undefined) {
      const clamped = Math.min(readSlotCount, totalSlotCount(comment.replySlotCount));
      data.readSlotCount = clamped;
      // The clamp only ever fires at the stored slot total, so a boundary that
      // was pulled back means "read to the end" — and its render-space twin is
      // then the live total, not whatever the client asked for. Each count is
      // clamped to its own space's total; the next sync recomputes the pair from
      // the real slot array either way.
      data.readMessageCount = clamped === readSlotCount
        ? Math.min(readMessageCount!, totalMessageCount(comment.replyCount))
        : totalMessageCount(comment.replyCount);
    }
    if (isStarred !== undefined) data.isStarred = isStarred;

    const result = await tx.comment.update({
      where: { commentId },
      data,
    });

    // Moving a comment to INBOX should also move the doc to INBOX if it's ARCHIVED
    if (status === CommentStatus.INBOX && comment.doc.status === DocStatus.ARCHIVED) {
      await tx.doc.update({
        where: { docId: comment.docId },
        data: { status: DocStatus.INBOX },
      });
    }

    return result;
  });

  return NextResponse.json(updated);
  });
}

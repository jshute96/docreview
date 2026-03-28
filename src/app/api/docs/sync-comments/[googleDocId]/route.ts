import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, invalidGrantResponse } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { logError, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

/**
 * Sync comments for a single doc, identified by Google doc ID.
 * Called by the Chrome extension when it detects comment activity
 * (reply, resolve, new comment, accept/reject suggestion) on a Google Docs page.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ googleDocId: string }> }
) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email ?? undefined;
    const { googleDocId } = await params;

    // Parse optional sync hints from the request body (sent by the extension
    // to narrow the sync to a single comment or skip irrelevant API calls).
    const body = await req.json().catch(() => ({}));
    // Unrecognized commentType values are safe — they won't match 'comment' or
    // 'suggestion', so both skip flags stay false, resulting in a full sync.
    const commentType = body.commentType as string | undefined;  // 'comment' | 'suggestion'
    const googleCommentId = body.googleCommentId as string | undefined;

    const doc = await prisma.doc.findFirst({ where: { googleDocId, userId } });
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let driveAuth;
    try {
      driveAuth = await getDriveClient(userId);
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      logError("[Comments] Drive auth error:", err);
      return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
    }

    const t0 = Date.now();
    const hints = (commentType || googleCommentId)
      ? { commentType, googleCommentId } : undefined;
    try {
      const result = await syncComments(doc, driveAuth, userEmail, undefined, hints);
      const mode = hints ? ` (${commentType}${googleCommentId ? ' single' : ''})` : '';
      logInfo(`[Comments] Synced comments for doc ${doc.docId}${mode} (${Date.now() - t0}ms)`, {
        created: result.commentsCreated + result.suggestionsCreated,
        updated: result.commentsUpdated + result.suggestionsUpdated,
      });
      // Include thread display data when available (single-comment sync) so the
      // extension can pass it to the client without a redundant Drive API fetch.
      // Shape matches GET /api/docs/{docId}/comments response for consistency.
      const { thread: _thread, ...resultWithoutThread } = result;
      const threads = result.thread && googleCommentId
        ? { [googleCommentId]: result.thread } : undefined;
      return NextResponse.json({ success: true, result: resultWithoutThread, threads });
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      logError(`[Comments] Failed to sync comments for doc ${doc.docId} (${Date.now() - t0}ms):`, err);
      return NextResponse.json({ error: "Failed to sync comments" }, { status: 502 });
    }
  });
}

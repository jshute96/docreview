import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchCommentContent, fetchSuggestionContent, fetchDocumentText } from "@/lib/google-drive";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const doc = await prisma.doc.findUnique({ where: { id } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect to Google Drive";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    const isDoc = doc.mimeType === DOCS_MIME_TYPE;
    const [commentContent, suggestions, documentText] = await Promise.all([
      fetchCommentContent(driveAuth, doc.googleDocId),
      isDoc ? fetchSuggestionContent(driveAuth, doc.googleDocId) : Promise.resolve({}),
      isDoc ? fetchDocumentText(driveAuth, doc.googleDocId) : Promise.resolve(undefined),
    ]);

    return NextResponse.json({ comments: commentContent, suggestions, ...(documentText != null ? { documentText } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch comment content";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchCommentContent, fetchSuggestionContent } from "@/lib/google-drive";

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
    const commentContent = await fetchCommentContent(driveAuth, doc.googleDocId);

    let suggestions: Record<string, { insertedText: string; deletedText: string }> = {};
    if (doc.mimeType === DOCS_MIME_TYPE) {
      suggestions = await fetchSuggestionContent(driveAuth, doc.googleDocId);
    }

    return NextResponse.json({ comments: commentContent, suggestions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch comment content";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

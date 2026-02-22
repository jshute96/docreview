import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchCommentContent, fetchSuggestionContent } from "@/lib/google-drive";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const doc = await prisma.doc.findUnique({ where: { id } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const driveAuth = await getDriveClient(userId);

  // fetchCommentContent also returns driveIdToDocsId — the mapping from Drive comment IDs
  // to Docs API suggestion IDs, needed to look up suggestion text content.
  const { commentContent, driveIdToDocsId } = await fetchCommentContent(driveAuth, doc.googleDocId);

  // Fetch suggestion text content from Docs API (keyed by Docs API suggestion ID).
  // Build a combined map covering both Docs-ID records (current) and any future Drive-ID
  // records (keyed via the driveIdToDocsId anchor mapping).
  let suggestions: Record<string, { insertedText: string; deletedText: string }> = {};
  if (doc.mimeType === DOCS_MIME_TYPE) {
    const docsContent = await fetchSuggestionContent(driveAuth, doc.googleDocId);
    // Include entries keyed by their Docs API suggestion ID (for existing records)
    Object.assign(suggestions, docsContent);
    // Also remap to Drive comment IDs if anchor mapping is available
    for (const [driveId, docsId] of Object.entries(driveIdToDocsId)) {
      const content = docsContent[docsId];
      if (content) suggestions[driveId] = content;
    }
  }

  return NextResponse.json({ comments: commentContent, suggestions });
}

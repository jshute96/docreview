import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchDocData, fetchFileTextViaExport, invalidGrantResponse } from "@/lib/google-drive";
import { runWithRequestId } from "@/lib/request-context";
import { GoogleMimeType } from "@/lib/mime-types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("GET", _req, async () => {
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

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const message = err instanceof Error ? err.message : "Failed to connect to Google Drive";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    const isDoc = doc.mimeType === GoogleMimeType.Doc;
    const isSlides = doc.mimeType === GoogleMimeType.Slides;

    if (isDoc) {
      const { documentText, suggestionContent } = await fetchDocData(driveAuth, doc.googleDocId);
      return NextResponse.json({ suggestions: suggestionContent, ...(documentText != null ? { documentText } : {}) });
    }

    if (isSlides) {
      const documentText = await fetchFileTextViaExport(driveAuth, doc.googleDocId);
      return NextResponse.json({ suggestions: {}, ...(documentText != null ? { documentText } : {}) });
    }

    return NextResponse.json({ suggestions: {} });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const message = err instanceof Error ? err.message : "Failed to fetch document content";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  });
}

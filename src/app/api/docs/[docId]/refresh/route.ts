import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, invalidGrantResponse } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { docWithCommentsInclude } from "@/lib/doc-queries";
import { logError, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", _req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? undefined;
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
    logError("[Refresh] Drive auth error:", err);
    return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
  }

  // Update file metadata first so lastModifiedInDrive is current before comment sync.
  // This matters because syncComments uses lastModifiedInDrive as the driveCreatedAt
  // timestamp for newly discovered suggestions.
  let freshDoc = doc;
  try {
    const drive = createDriveService(driveAuth);
    const fileRes = await drive.files.get({
      fileId: doc.googleDocId,
      fields: "name, mimeType, webViewLink, modifiedTime, owners(displayName), trashed",
    });
    const f = fileRes.data;
    const isTrashed = f.trashed === true;
    freshDoc = await prisma.doc.update({
      where: { docId },
      data: {
        title: f.name ?? doc.title,
        mimeType: f.mimeType ?? doc.mimeType,
        driveUrl: f.webViewLink ?? doc.driveUrl,
        lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : doc.lastModifiedInDrive,
        owner: f.owners?.[0]?.displayName ?? doc.owner,
        isDeleted: isTrashed, // Access confirmed, but might be trashed
      },
    });
  } catch (err: unknown) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const code = (err as { code?: number })?.code;
    if (code === 404 || code === 403) {
      logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) is deleted or inaccessible (code ${code})`);
      freshDoc = await prisma.doc.update({
        where: { docId },
        data: { isDeleted: true },
      });
    } else {
      logError("[Refresh] Failed to refresh file metadata:", err);
    }
  }

  // If we already confirmed it's deleted, skip comment sync
  if (!freshDoc.isDeleted) {
    const syncResult = await syncComments(freshDoc, driveAuth, userEmail);
    if (syncResult.isDeleted && !freshDoc.isDeleted) {
      await prisma.doc.update({
        where: { docId },
        data: { isDeleted: true },
      });
    }
  }

  const updated = await prisma.doc.findUnique({
    where: { docId },
    include: docWithCommentsInclude,
  });

  return NextResponse.json(updated);
  });
}

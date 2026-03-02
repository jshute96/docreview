import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, invalidGrantResponse } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { docWithCommentsInclude } from "@/lib/doc-queries";

export async function POST(
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
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    console.error("Drive auth error:", err);
    return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
  }

  // Update file metadata first so lastModifiedInDrive is current before comment sync.
  // This matters because syncComments uses lastModifiedInDrive as the driveCreatedAt
  // timestamp for newly discovered suggestions.
  let freshDoc = doc;
  try {
    const drive = google.drive({ version: "v3", auth: driveAuth });
    const fileRes = await drive.files.get({
      fileId: doc.googleDocId,
      fields: "name, mimeType, webViewLink, modifiedTime, owners(displayName), trashed",
    });
    const f = fileRes.data;
    const isTrashed = f.trashed === true;
    freshDoc = await prisma.doc.update({
      where: { id },
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
      console.log(`[Refresh] doc ${doc.id} (${doc.googleDocId}) is deleted or inaccessible (code ${code})`);
      freshDoc = await prisma.doc.update({
        where: { id },
        data: { isDeleted: true },
      });
    } else {
      console.error("Failed to refresh file metadata:", err);
    }
  }

  // If we already confirmed it's deleted, skip comment sync
  if (!freshDoc.isDeleted) {
    const syncResult = await syncComments(freshDoc, driveAuth);
    if (syncResult.isDeleted && !freshDoc.isDeleted) {
      await prisma.doc.update({
        where: { id },
        data: { isDeleted: true },
      });
    }
  }

  const updated = await prisma.doc.findUnique({
    where: { id },
    include: docWithCommentsInclude,
  });

  return NextResponse.json(updated);
}

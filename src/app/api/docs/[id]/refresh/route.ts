import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient } from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";

export async function POST(
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

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
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
      fields: "name, mimeType, webViewLink, modifiedTime, owners(displayName)",
    });
    const f = fileRes.data;
    freshDoc = await prisma.doc.update({
      where: { id },
      data: {
        title: f.name ?? doc.title,
        mimeType: f.mimeType ?? doc.mimeType,
        driveUrl: f.webViewLink ?? doc.driveUrl,
        lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : doc.lastModifiedInDrive,
        owner: f.owners?.[0]?.displayName ?? doc.owner,
      },
    });
  } catch (err) {
    console.error("Failed to refresh file metadata:", err);
  }

  await syncComments(freshDoc, driveAuth);

  const updated = await prisma.doc.findUnique({
    where: { id },
    include: {
      labels: { include: { label: true } },
      comments: { orderBy: { driveCreatedAt: "asc" } },
    },
  });

  return NextResponse.json(updated);
}

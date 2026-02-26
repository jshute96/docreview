import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  parseGoogleDocId,
  SUPPORTED_MIME_TYPES,
} from "@/lib/google-drive";
import { google } from "googleapis";

export async function GET(req: NextRequest) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const fileId = parseGoogleDocId(url);
  if (!fileId) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const existing = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId: fileId } },
  });
  if (existing) {
    return NextResponse.json({ error: "already_exists" }, { status: 409 });
  }

  let f;
  try {
    const driveAuth = await getDriveClient(userId);
    const drive = google.drive({ version: "v3", auth: driveAuth });
    const res = await drive.files.get({
      fileId,
      fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
    });
    f = res.data;
  } catch {
    return NextResponse.json({ error: "no_access" }, { status: 404 });
  }

  if (f.trashed) {
    return NextResponse.json({ error: "trashed" }, { status: 400 });
  }

  if (!f.mimeType || !SUPPORTED_MIME_TYPES.has(f.mimeType)) {
    return NextResponse.json({ error: "invalid_mime_type" }, { status: 400 });
  }

  const isOwner = f.owners?.some((o) => o.me === true) ?? false;

  return NextResponse.json({
    googleDocId: fileId,
    title: f.name ?? "",
    mimeType: f.mimeType,
    driveUrl: f.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
    role: isOwner ? "AUTHOR" : "REVIEWER",
    owner: f.owners?.[0]?.displayName ?? null,
    lastModifiedInDrive: f.modifiedTime ?? null,
    createdTimeInDrive: f.createdTime ?? null,
  });
}

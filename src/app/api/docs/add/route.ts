import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  parseGoogleDocId,
  SUPPORTED_MIME_TYPES,
} from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { google } from "googleapis";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";

export async function POST(req: NextRequest) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { url, labelIds = [] } = body as { url: string; labelIds?: string[] };

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

  if (labelIds.length > 0) {
    const ownedLabels = await prisma.label.findMany({
      where: { id: { in: labelIds }, userId },
      select: { id: true },
    });
    if (ownedLabels.length !== labelIds.length) {
      return NextResponse.json({ error: "Invalid label" }, { status: 400 });
    }
  }

  let f;
  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
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

  const doc = await prisma.doc.create({
    data: {
      userId,
      googleDocId: fileId,
      title: f.name ?? "",
      driveUrl: f.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
      mimeType: f.mimeType,
      role: isOwner ? "AUTHOR" : "REVIEWER",
      owner: f.owners?.[0]?.displayName ?? null,
      lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : null,
      createdTimeInDrive: f.createdTime ? new Date(f.createdTime) : null,
      ...(labelIds.length > 0
        ? { labels: { create: labelIds.map((labelId: string) => ({ labelId })) } }
        : {}),
    },
  });

  await syncComments(doc, driveAuth);

  const result = await prisma.doc.findUnique({
    where: { id: doc.id },
    include: docWithCountsInclude,
  });

  return NextResponse.json(result ? withCommentCounts(result) : result, { status: 201 });
}

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  parseGoogleDocId,
  SUPPORTED_MIME_TYPES,
  invalidGrantResponse,
  driveUrlFor,
} from "@/lib/google-drive";
import { runWithRequestId } from "@/lib/request-context";
import { tryResolveRedirect } from "@/lib/url-utils";

export async function GET(req: NextRequest) {
  return runWithRequestId("GET", req, async () => {
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

  let fileId = parseGoogleDocId(url);

  // If the URL isn't a recognized Google Doc link, try following redirects
  // to see if it lands on one (e.g. go/my-doc → docs.google.com/document/d/...).
  if (!fileId) {
    const resolved = await tryResolveRedirect(url);
    if (resolved) {
      fileId = parseGoogleDocId(resolved);
    }
  }

  if (!fileId) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const existingRow = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId: fileId } },
    select: {
      docId: true, title: true, mimeType: true,
      notes: true, status: true, isStarred: true, accessState: true,
      labels: { select: { labelId: true } },
    },
  });
  const existing = existingRow ?? null;

  let f;
  try {
    const driveAuth = await getDriveClient(userId);
    const drive = createDriveService(driveAuth);
    const res = await drive.files.get({
      fileId,
      fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
      supportsAllDrives: true,
    });
    f = res.data;
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    // Not found or permission denied — still allow adding
    return NextResponse.json({
      googleDocId: fileId,
      title: existing?.title ?? "Unknown title",
      mimeType: existing?.mimeType ?? "application/vnd.google-apps.document",
      driveUrl: driveUrlFor(fileId),
      permissionDenied: true,
      ...(existing ? {
        existing: true,
        docId: existing.docId,
        labels: existing.labels.map((l) => l.labelId),
        notes: existing.notes,
        status: existing.status,
        isStarred: existing.isStarred,
      } : {}),
    });
  }

  if (f.trashed) {
    return NextResponse.json({
      error: "trashed",
      title: f.name ?? "",
      mimeType: f.mimeType,
      driveUrl: driveUrlFor(fileId, f.webViewLink),
    }, { status: 400 });
  }

  if (!f.mimeType || !SUPPORTED_MIME_TYPES.has(f.mimeType)) {
    return NextResponse.json({
      error: "invalid_mime_type",
      title: f.name ?? "",
      mimeType: f.mimeType,
      driveUrl: driveUrlFor(fileId, f.webViewLink),
    }, { status: 400 });
  }

  const isOwner = f.owners?.some((o) => o.me === true) ?? false;

  return NextResponse.json({
    googleDocId: fileId,
    title: f.name ?? "",
    mimeType: f.mimeType,
    driveUrl: driveUrlFor(fileId, f.webViewLink),
    role: isOwner ? "AUTHOR" : "REVIEWER",
    lastModifiedInDrive: f.modifiedTime ?? null,
    createdTimeInDrive: f.createdTime ?? null,
    ...(existing ? {
      existing: true,
      docId: existing.docId,
      labels: existing.labels.map((l) => l.labelId),
      notes: existing.notes,
      status: existing.status,
      isStarred: existing.isStarred,
    } : {}),
  });
  });
}

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
  isDriveErrorCode,
  getDriveErrorCode,
} from "@/lib/google-drive";
import { OfflineModeError } from "@/lib/offline";
import { logError, logWarning } from "@/lib/log";
import { DocErrorCode } from "@/lib/doc-error-codes";
import { GoogleMimeType } from "@/lib/mime-types";
import { runWithRequestId } from "@/lib/request-context";
import { tryResolveRedirect } from "@/lib/url-utils";
import { DocRole } from "@prisma/client";

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
    return NextResponse.json({ error: DocErrorCode.InvalidUrl }, { status: 400 });
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
    // Anything other than "gone or no access" is a real failure — reporting it
    // as permission-denied would add a doc with placeholder metadata. Offline
    // mode keeps the fallback: adding by URL has to work with no Drive access.
    const noAccess = isDriveErrorCode(err, 403) || isDriveErrorCode(err, 404) || err instanceof OfflineModeError;
    if (!noAccess) {
      logError(`[Drive] files.get ${fileId} failed during validate:`, err);
      return NextResponse.json({ error: DocErrorCode.LookupFailed }, { status: 502 });
    }
    // Not found or permission denied — still allow adding
    if (!(err instanceof OfflineModeError)) {
      logWarning(`[Drive] No access to ${fileId} during validate (code ${getDriveErrorCode(err)})`);
    }
    return NextResponse.json({
      googleDocId: fileId,
      title: existing?.title ?? "Unknown title",
      mimeType: existing?.mimeType ?? GoogleMimeType.Doc,
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
      error: DocErrorCode.Trashed,
      title: f.name ?? "",
      mimeType: f.mimeType,
      driveUrl: driveUrlFor(fileId, f.webViewLink),
    }, { status: 400 });
  }

  if (!f.mimeType || !SUPPORTED_MIME_TYPES.has(f.mimeType)) {
    return NextResponse.json({
      error: DocErrorCode.InvalidMimeType,
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
    role: isOwner ? DocRole.AUTHOR : DocRole.REVIEWER,
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

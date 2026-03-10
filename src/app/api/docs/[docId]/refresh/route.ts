import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, invalidGrantResponse } from "@/lib/google-drive";
import { upsertDocsAndSyncComments } from "@/lib/refresh";
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
  let driveDoc;
  try {
    const drive = createDriveService(driveAuth);
    const fileRes = await drive.files.get({
      fileId: doc.googleDocId,
      fields: "id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed",
    });
    const f = fileRes.data;
    const isOwner = f.owners?.some((o) => o.me === true) ?? false;
    driveDoc = {
      googleDocId: f.id!,
      title: f.name!,
      driveUrl: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}/edit`,
      mimeType: f.mimeType!,
      role: isOwner ? "AUTHOR" : "REVIEWER",
      lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : null,
      createdTimeInDrive: f.createdTime ? new Date(f.createdTime) : null,
      owner: f.owners?.[0]?.displayName ?? null,
      trashed: f.trashed === true,
    } as any;
  } catch (err: unknown) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const code = (err as { code?: number })?.code;
    if (code === 404) {
      // 404 is ambiguous for DENIED docs (Google returns 404 for permission denied too)
      if (doc.accessState !== "DENIED") {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) not found (code 404)`);
        await prisma.doc.update({ where: { docId }, data: { accessState: "NOT_FOUND" } });
      } else {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) still inaccessible (code 404, keeping DENIED)`);
      }
    } else if (code === 403) {
      logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) permission denied (code 403)`);
      await prisma.doc.update({ where: { docId }, data: { accessState: "DENIED" } });
    } else {
      logError("[Refresh] Failed to refresh file metadata:", err);
    }
  }

  if (driveDoc) {
    if (driveDoc.trashed) {
      await prisma.doc.update({ where: { docId }, data: { accessState: "TRASHED" } });
    } else {
      await upsertDocsAndSyncComments(userId, userEmail, [driveDoc], {
        existingDocIds: new Set([doc.googleDocId]),
        mode: "selected",
        docId
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

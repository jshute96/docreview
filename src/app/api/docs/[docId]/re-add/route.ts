import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  SUPPORTED_MIME_TYPES,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { runWithRequestId } from "@/lib/request-context";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email ?? undefined;
    const { docId: oldDocId } = await params;

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const { labelIds = [], isStarred, notes, status } = body as {
      labelIds?: string[];
      isStarred?: boolean;
      notes?: string;
      status?: "INBOX" | "ARCHIVED";
    };

    if (status !== undefined && status !== "INBOX" && status !== "ARCHIVED") {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    if (isStarred !== undefined && typeof isStarred !== "boolean") {
      return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
    }

    // Find old doc
    const oldDoc = await prisma.doc.findUnique({
      where: { docId: oldDocId },
    });

    if (!oldDoc || oldDoc.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const googleDocId = oldDoc.googleDocId;

    if (labelIds.length > 0) {
      const ownedLabels = await prisma.label.findMany({
        where: { labelId: { in: labelIds }, userId },
        select: { labelId: true },
      });
      if (ownedLabels.length !== labelIds.length) {
        return NextResponse.json({ error: "Invalid label" }, { status: 400 });
      }
    }

    // Verify access and get fresh metadata
    let f;
    let driveAuth;
    try {
      driveAuth = await getDriveClient(userId);
      const drive = createDriveService(driveAuth);
      const res = await drive.files.get({
        fileId: googleDocId,
        fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
      });
      f = res.data;
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      return NextResponse.json({ error: "no_access" }, { status: 404 });
    }

    if (f.trashed) {
      return NextResponse.json({ error: "trashed" }, { status: 400 });
    }

    if (!f.mimeType || !SUPPORTED_MIME_TYPES.has(f.mimeType)) {
      return NextResponse.json({ error: "invalid_mime_type" }, { status: 400 });
    }

    const isOwner = f.owners?.some((o) => o.me === true) ?? false;

    // Transactional delete and create
    const newDoc = await prisma.$transaction(async (tx) => {
      // 1. Delete old doc (cascades to comments, doc_labels, etc.)
      await tx.doc.delete({ where: { docId: oldDocId } });

      // 2. Create new doc
      return await tx.doc.create({
        data: {
          userId,
          googleDocId,
          title: f.name ?? "",
          driveUrl: f.webViewLink ?? `https://docs.google.com/document/d/${googleDocId}/edit`,
          mimeType: f.mimeType,
          role: isOwner ? "AUTHOR" : "REVIEWER",
          status: status ?? "INBOX",
          owner: f.owners?.[0]?.displayName ?? null,
          lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : null,
          createdTimeInDrive: f.createdTime ? new Date(f.createdTime) : null,
          notes: notes || null,
          isStarred: isStarred ?? false,
          labels: {
            create: labelIds.map((labelId: string) => ({ labelId })),
          },
        },
      });
    });

    // syncComments (after transaction)
    await syncComments(newDoc, driveAuth, userEmail);

    const result = await prisma.doc.findUnique({
      where: { docId: newDoc.docId },
      include: docWithCountsInclude,
    });

    return NextResponse.json(result ? withCommentCounts(result) : result, { status: 201 });
  });
}

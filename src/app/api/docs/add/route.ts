import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  parseGoogleDocId,
  SUPPORTED_MIME_TYPES,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { runWithRequestId } from "@/lib/request-context";

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? undefined;

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { url, labelIds = [], isStarred, notes, status, title: customTitle } = body as {
    url: string;
    labelIds?: string[];
    isStarred?: boolean;
    notes?: string;
    status?: "INBOX" | "ARCHIVED";
    title?: string;
  };

  if (status !== undefined && status !== "INBOX" && status !== "ARCHIVED") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
  }

  const fileId = parseGoogleDocId(url);
  if (!fileId) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const existingRow = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId: fileId } },
    select: { docId: true, accessState: true },
  });
  const existing = existingRow?.accessState !== "OK" ? null : existingRow;

  if (labelIds.length > 0) {
    const ownedLabels = await prisma.label.findMany({
      where: { labelId: { in: labelIds }, userId },
      select: { labelId: true },
    });
    if (ownedLabels.length !== labelIds.length) {
      return NextResponse.json({ error: "Invalid label" }, { status: 400 });
    }
  }

  if (existing) {
    // Update existing doc: replace labels, update notes and status
    await prisma.$transaction([
      prisma.docLabel.deleteMany({ where: { docId: existing.docId } }),
      ...(labelIds.length > 0
        ? [prisma.docLabel.createMany({
            data: labelIds.map((labelId: string) => ({ docId: existing.docId, labelId })),
          })]
        : []),
      prisma.doc.update({
        where: { docId: existing.docId },
        data: {
          notes: notes || null,
          status: status ?? "INBOX",
          ...(isStarred !== undefined ? { isStarred } : {}),
        },
      }),
    ]);

    const result = await prisma.doc.findUnique({
      where: { docId: existing.docId },
      include: docWithCountsInclude,
    });

    return NextResponse.json(result ? withCommentCounts(result) : result);
  }

  let f;
  let driveAuth;
  let permissionDenied = false;
  try {
    driveAuth = await getDriveClient(userId);
    const drive = createDriveService(driveAuth);
    const res = await drive.files.get({
      fileId,
      fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
    });
    f = res.data;
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    // Not found or permission denied — allow adding in permission-denied state
    permissionDenied = true;
  }

  if (permissionDenied) {
    const now = new Date();
    const permDeniedData = {
      title: customTitle || "Unknown title",
      driveUrl: `https://docs.google.com/document/d/${fileId}/edit`,
      mimeType: "application/vnd.google-apps.document",
      role: "REVIEWER" as const,
      status: (status ?? "INBOX") as "INBOX" | "ARCHIVED",
      accessState: "DENIED" as const,
      lastModifiedInDrive: now,
      createdTimeInDrive: now,
      notes: notes || null,
      ...(isStarred !== undefined ? { isStarred } : {}),
    };

    // Upsert to handle soft-deleted rows that still exist in the DB
    const doc = await prisma.doc.upsert({
      where: { userId_googleDocId: { userId, googleDocId: fileId } },
      create: {
        userId,
        googleDocId: fileId,
        ...permDeniedData,
        ...(labelIds.length > 0
          ? { labels: { create: labelIds.map((labelId: string) => ({ labelId })) } }
          : {}),
      },
      update: {
        ...permDeniedData,
      },
    });

    // Replace labels on update
    if (existingRow) {
      await prisma.docLabel.deleteMany({ where: { docId: doc.docId } });
    }
    if (labelIds.length > 0) {
      await prisma.docLabel.createMany({
        data: labelIds.map((labelId: string) => ({ docId: doc.docId, labelId })),
        skipDuplicates: true,
      });
    }

    const result = await prisma.doc.findUnique({
      where: { docId: doc.docId },
      include: docWithCountsInclude,
    });

    return NextResponse.json(result ? withCommentCounts(result) : result, { status: 201 });
  }

  if (f!.trashed) {
    return NextResponse.json({ error: "trashed" }, { status: 400 });
  }

  if (!f!.mimeType || !SUPPORTED_MIME_TYPES.has(f!.mimeType)) {
    return NextResponse.json({ error: "invalid_mime_type" }, { status: 400 });
  }

  const isOwner = f!.owners?.some((o) => o.me === true) ?? false;

  const doc = await prisma.doc.create({
    data: {
      userId,
      googleDocId: fileId,
      title: f!.name ?? "",
      driveUrl: f!.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
      mimeType: f!.mimeType,
      role: isOwner ? "AUTHOR" : "REVIEWER",
      status: status ?? "INBOX",
      owner: f!.owners?.[0]?.displayName ?? null,
      lastModifiedInDrive: f!.modifiedTime ? new Date(f!.modifiedTime) : null,
      createdTimeInDrive: f!.createdTime ? new Date(f!.createdTime) : null,
      notes: notes || null,
      ...(isStarred !== undefined ? { isStarred } : {}),
      ...(labelIds.length > 0
        ? { labels: { create: labelIds.map((labelId: string) => ({ labelId })) } }
        : {}),
    },
  });

  await syncComments(doc, driveAuth!, userEmail);

  const result = await prisma.doc.findUnique({
    where: { docId: doc.docId },
    include: docWithCountsInclude,
  });

  return NextResponse.json(result ? withCommentCounts(result) : result, { status: 201 });
  });
}

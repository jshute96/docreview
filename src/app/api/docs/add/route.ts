import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { parseGoogleDocId, driveUrlFor } from "@/lib/google-drive";
import { addDoc, validateDocInputs } from "@/lib/add-doc";
import { docWithCountsInclude, withCommentCounts, stripServerOnly } from "@/lib/doc-queries";
import { DocErrorCode } from "@/lib/doc-error-codes";
import { runWithRequestId } from "@/lib/request-context";
import { DocRole, DocStatus } from "@prisma/client";

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
    status?: DocStatus;
    title?: string;
  };

  const fileId = parseGoogleDocId(url);
  if (!fileId) {
    return NextResponse.json({ error: DocErrorCode.InvalidUrl }, { status: 400 });
  }

  const existing = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId: fileId } },
    select: { docId: true },
  });

  if (existing) {
    // Validate inputs before updating existing doc
    const validationError = await validateDocInputs({ userId, labelIds, status, isStarred });
    if (validationError) return validationError;

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
          status: status ?? DocStatus.INBOX,
          ...(isStarred !== undefined ? { isStarred } : {}),
        },
      }),
    ]);

    const result = await prisma.doc.findUnique({
      where: { docId: existing.docId },
      include: docWithCountsInclude,
    });

    return NextResponse.json(result ? stripServerOnly(withCommentCounts(result)) : result);
  }

  const now = new Date();
  return addDoc({
    userId,
    userEmail,
    googleDocId: fileId,
    labelIds,
    isStarred,
    notes,
    status,
    fallback: {
      title: customTitle || "Unknown title",
      driveUrl: driveUrlFor(fileId),
      mimeType: "application/vnd.google-apps.document",
      role: DocRole.REVIEWER,
      lastModifiedInDrive: now,
      createdTimeInDrive: now,
    },
  });
  });
}

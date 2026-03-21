import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { DocRole, DocStatus } from "@prisma/client";
import { docWithCountsInclude, docWithCommentsInclude, withCommentCounts, stripServerOnly } from "@/lib/doc-queries";
import { runWithRequestId } from "@/lib/request-context";
import { validateLabelOwnership } from "@/lib/add-doc";

const VALID_ROLES: string[] = Object.values(DocRole);
const VALID_STATUSES: string[] = Object.values(DocStatus);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("GET", _req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId } = await params;

  const doc = await prisma.doc.findUnique({
    where: { docId },
    include: docWithCommentsInclude,
  });

  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(stripServerOnly(doc));
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId } = await params;

  const doc = await prisma.doc.findUnique({ where: { docId } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { role, status, labelIds, notes, isStarred } = body as {
    role?: DocRole;
    status?: DocStatus;
    labelIds?: string[];
    notes?: string | null;
    isStarred?: boolean;
  };

  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  if (labelIds !== undefined) {
    if (!Array.isArray(labelIds)) {
      return NextResponse.json({ error: "Invalid labelIds" }, { status: 400 });
    }
    const labelError = await validateLabelOwnership(userId, labelIds);
    if (labelError) return labelError;
  }

  const updated = await prisma.doc.update({
    where: { docId },
    data: {
      ...(role !== undefined ? { role } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(isStarred !== undefined ? { isStarred } : {}),
      ...(notes !== undefined ? { notes: notes || null } : {}),
      ...(labelIds !== undefined
        ? {
            labels: {
              deleteMany: {},
              create: labelIds.map((labelId) => ({ labelId })),
            },
          }
        : {}),
    },
    include: docWithCountsInclude,
  });

  return NextResponse.json(stripServerOnly(withCommentCounts(updated)));
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("DELETE", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { docId } = await params;

  const doc = await prisma.doc.findUnique({ where: { docId } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.doc.delete({ where: { docId } });

  return new NextResponse(null, { status: 204 });
  });
}

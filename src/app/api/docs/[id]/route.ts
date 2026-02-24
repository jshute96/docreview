import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DocRole, DocStatus } from "@prisma/client";

const VALID_ROLES: string[] = Object.values(DocRole);
const VALID_STATUSES: string[] = Object.values(DocStatus);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const doc = await prisma.doc.findUnique({
    where: { id },
    include: {
      labels: { include: { label: true } },
      comments: { orderBy: { driveCreatedAt: "asc" } },
    },
  });

  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(doc);
}

export async function PATCH(
  req: NextRequest,
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

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { role, status, labelIds } = body as {
    role?: DocRole;
    status?: DocStatus;
    labelIds?: string[];
  };

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
    if (labelIds.length > 0) {
      const ownedLabels = await prisma.label.findMany({
        where: { id: { in: labelIds }, userId },
        select: { id: true },
      });
      if (ownedLabels.length !== labelIds.length) {
        return NextResponse.json({ error: "Invalid label" }, { status: 400 });
      }
    }
  }

  const updated = await prisma.doc.update({
    where: { id },
    data: {
      ...(role !== undefined ? { role } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(labelIds !== undefined
        ? {
            labels: {
              deleteMany: {},
              create: labelIds.map((labelId) => ({ labelId })),
            },
          }
        : {}),
    },
    include: {
      labels: { include: { label: true } },
      _count: { select: { comments: { where: { status: "ACTIVE" } } } },
    },
  });

  return NextResponse.json(updated);
}

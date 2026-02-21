import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

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

  const body = await req.json();
  const { role, status, labelIds } = body as {
    role?: string;
    status?: string;
    labelIds?: string[];
  };

  const updated = await prisma.doc.update({
    where: { id },
    data: {
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(labelIds !== undefined
        ? {
            labels: {
              deleteMany: {},
              create: labelIds.map((labelId) => ({ labelId })),
            },
          }
        : {}),
    },
    include: { labels: { include: { label: true } } },
  });

  return NextResponse.json(updated);
}

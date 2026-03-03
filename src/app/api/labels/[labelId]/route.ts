import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { runWithRequestId } from "@/lib/request-context";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ labelId: string }> }
) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { labelId } = await params;

  const label = await prisma.label.findUnique({ where: { labelId } });
  if (!label || label.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { color } = body as { color?: string };

  const updated = await prisma.label.update({
    where: { labelId },
    data: { color: color ?? null },
  });

  return NextResponse.json(updated);
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ labelId: string }> }
) {
  return runWithRequestId("DELETE", _req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { labelId } = await params;

  const label = await prisma.label.findUnique({ where: { labelId } });
  if (!label || label.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.label.delete({ where: { labelId } });
  return new NextResponse(null, { status: 204 });
  });
}

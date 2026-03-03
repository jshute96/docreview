import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { runWithRequestId } from "@/lib/request-context";

export async function PATCH(req: NextRequest) {
  return runWithRequestId("PATCH", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { order } = body as { order?: string[] };

  if (!Array.isArray(order) || order.length === 0) {
    return NextResponse.json({ error: "order must be a non-empty array of label IDs" }, { status: 400 });
  }

  // Validate all IDs belong to the current user
  const labels = await prisma.label.findMany({
    where: { userId },
    select: { labelId: true },
  });
  const ownedIds = new Set(labels.map((l) => l.labelId));
  if (order.length !== ownedIds.size || new Set(order).size !== order.length) {
    return NextResponse.json({ error: "order must include all labels exactly once" }, { status: 400 });
  }
  for (const id of order) {
    if (!ownedIds.has(id)) {
      return NextResponse.json({ error: "Invalid label ID" }, { status: 400 });
    }
  }

  // Update each label's position to its index
  await prisma.$transaction(
    order.map((labelId, index) =>
      prisma.label.update({ where: { labelId }, data: { position: index } })
    )
  );

  return NextResponse.json({ ok: true });
  });
}

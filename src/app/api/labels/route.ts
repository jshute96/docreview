import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { runWithRequestId } from "@/lib/request-context";

export async function GET(req: NextRequest) {
  return runWithRequestId("GET", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const labels = await prisma.label.findMany({
    where: { userId },
    include: { _count: { select: { docs: true } } },
    orderBy: { position: "asc" },
  });

  return NextResponse.json(labels);
  });
}

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { name, color } = body as { name?: string; color?: string };

  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  try {
    const label = await prisma.label.create({
      data: { userId, name: name.trim(), color: color ?? null },
      include: { _count: { select: { docs: true } } },
    });
    return NextResponse.json(label, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A label with that name already exists" }, { status: 409 });
    }
    throw err;
  }
  });
}

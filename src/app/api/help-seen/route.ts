import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { runWithRequestId } from "@/lib/request-context";

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await prisma.status.upsert({
      where: { userId: session.user.id },
      update: { hasSeenHelp: true },
      create: { userId: session.user.id, hasSeenHelp: true },
    });

    return NextResponse.json({ ok: true });
  });
}

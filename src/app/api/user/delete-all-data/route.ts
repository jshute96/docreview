import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { logInfo, logError } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

export async function DELETE(req: NextRequest) {
  return runWithRequestId("DELETE", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const { deleteAccount } = await req.json() as { deleteAccount: boolean };

    try {
      if (deleteAccount) {
        logInfo(`[API] delete-all-data deleteAccount=true`);
        // Delete the user row — cascades to accounts, sessions, docs, comments,
        // labels, doc_labels, and status.
        await prisma.user.delete({ where: { id: userId } });
      } else {
        logInfo(`[API] delete-all-data deleteAccount=false`);
        // Delete app data only, keep user/account/session intact.
        // Docs first (cascades to comments and doc_labels), then labels, then status.
        await prisma.$transaction([
          prisma.doc.deleteMany({ where: { userId } }),
          prisma.label.deleteMany({ where: { userId } }),
          prisma.status.deleteMany({ where: { userId } }),
        ]);
      }
    } catch (err) {
      logError(`[API] delete-all-data failed`, err);
      return NextResponse.json({ error: "Delete failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  });
}

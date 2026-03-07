import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { refreshSelectedDocs } from "@/lib/refresh";
import { logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { createProgressStream } from "@/lib/sse";

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email ?? undefined;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no body */ }

    const docIds = Array.isArray(body.docIds) ? body.docIds.filter((id): id is string => typeof id === "string") : [];
    if (docIds.length === 0) {
      return NextResponse.json({ error: "No docIds specified" }, { status: 400 });
    }

    logInfo(`[API] Refresh selected request: ${docIds.length} docs`);

    return createProgressStream(async (send) => {
      return await refreshSelectedDocs(userId, userEmail, docIds, send);
    });
  });
}

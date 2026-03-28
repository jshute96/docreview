import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { executeRefresh } from "@/lib/refresh";
import { prisma } from "@/lib/prisma";
import { logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { createProgressStream } from "@/lib/sse";

const VALID_SOURCES = new Set(["drive", "gmail"]);

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email ?? undefined;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* no body -> defaults */ }

    // Direct refresh: fetch metadata directly by doc ID, bypassing
    // Drive changes / Gmail discovery.
    const docIds = Array.isArray(body.docIds)
      ? body.docIds.filter((id): id is string => typeof id === "string")
      : [];

    if (body.mode === "full" || docIds.length > 0) {
      let googleDocIds: string[];
      let refreshMode: "full-refresh" | "selected";
      if (docIds.length > 0) {
        // Subset: convert DB docIds to Google Doc IDs
        const docs = await prisma.doc.findMany({
          where: { userId, docId: { in: docIds } },
          select: { googleDocId: true },
        });
        googleDocIds = docs.map(d => d.googleDocId);
        refreshMode = "selected";
        logInfo(`[API] Refresh selected request: ${googleDocIds.length} docs`);
      } else {
        // All tracked docs
        const docs = await prisma.doc.findMany({
          where: { userId },
          select: { googleDocId: true },
        });
        googleDocIds = docs.map(d => d.googleDocId);
        refreshMode = "full-refresh";
        logInfo(`[API] Full refresh request: ${googleDocIds.length} docs`);
      }

      return createProgressStream(async (send) => {
        return await executeRefresh(userId, userEmail, {
          googleDocIds,
          mode: refreshMode,
          onProgress: send,
        });
      });
    }

    // Discovery refresh: use Drive changes API and/or Gmail scan
    const rawSources = Array.isArray(body.sources) ? body.sources : ["drive", "gmail"];
    const sources = rawSources.filter((s): s is string => VALID_SOURCES.has(s as string));
    if (sources.length === 0) {
      return NextResponse.json({ error: "No valid sources specified" }, { status: 400 });
    }

    logInfo(`[API] Refresh request: sources=${sources.join(",")}`);

    return createProgressStream(async (send) => {
      return await executeRefresh(userId, userEmail, {
        drive: sources.includes("drive"),
        gmail: sources.includes("gmail"),
        onProgress: send,
      });
    });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { executeRefresh } from "@/lib/refresh";
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

    // Parse and validate sources (default to both)
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

import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs } from "@/lib/google-drive";
import { scanGmailNotifications } from "@/lib/gmail";
import { parseLoadOptions } from "@/lib/load-options";
import { logInfo, logError } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import { formatDate } from "@/lib/utils";
import { createProgressStream } from "@/lib/sse";

export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body ok */ }

    const { daysBack, ownership, includeSharedDrives, source } = parseLoadOptions(body);

    return createProgressStream(async (send) => {
      const existingDocIds = new Set(
        (await prisma.doc.findMany({
          where: { userId },
          select: { googleDocId: true },
        })).map((d) => d.googleDocId)
      );

      if (source === "gmail") {
        const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
        logInfo(`[Scan] Starting Gmail scan: daysBack=${daysBack}, since=${formatDate(since)}`);

        try {
          const { docs: gmailDocs, errorCount } = await scanGmailNotifications(userId, since, send);

          const docs = gmailDocs.map(d => ({
            googleDocId: d.googleDocId,
            title: d.title,
            mimeType: d.mimeType,
            driveUrl: d.driveUrl,
            owner: d.owner,
            role: d.role,
            isNew: !existingDocIds.has(d.googleDocId),
          }));

          const existingCount = docs.filter(d => !d.isNew).length;
          logInfo(`[Scan] Gmail scan found ${gmailDocs.length} total docs, ${gmailDocs.length - existingCount} new, ${errorCount} errors`);

          return {
            total: gmailDocs.length,
            existingCount,
            errorCount,
            docs,
          };
        } catch (err) {
          logError("[Scan] Gmail error:", err);
          throw err; // Re-throw to let createProgressStream handle SSE error event
        }
      }

      logInfo(`[Scan] Starting Drive scan: daysBack=${daysBack}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}`);

      try {
        const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
        send({ phase: "drive", status: "reading", count: 0 });
        const driveDocs = await listRecentDocs(userId, since, { ownership, includeSharedDrives }, (stats) => {
          send({ phase: "drive", status: "reading", ...stats });
        });
        send({ phase: "drive", status: "done", count: driveDocs.length });

        const docs = driveDocs.map(d => ({
          googleDocId: d.googleDocId,
          title: d.title,
          mimeType: d.mimeType,
          driveUrl: d.driveUrl,
          owner: d.owner,
          role: d.role,
          isNew: !existingDocIds.has(d.googleDocId),
        }));

        const existingCount = docs.filter(d => !d.isNew).length;
        logInfo(`[Scan] Found ${driveDocs.length} total docs, ${driveDocs.length - existingCount} new`);

        return {
          total: driveDocs.length,
          existingCount,
          docs,
        };
      } catch (err) {
        logError("[Scan] Drive error:", err);
        throw err;
      }
    });
  });
}

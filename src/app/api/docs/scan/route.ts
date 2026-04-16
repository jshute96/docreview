import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, driveUrlFor } from "@/lib/google-drive";
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
        const since = daysBack !== null
          ? new Date(Math.max(0, Date.now() - daysBack * 24 * 60 * 60 * 1000))
          : new Date(0);
        logInfo(`[Scan] Starting Gmail scan: daysBack=${daysBack ?? "all"}, since=${formatDate(since)}`);

        try {
          const userEmail = session.user.email ?? undefined;
          const { docs: gmailDocs, inaccessibleDocs, errorCount } = await scanGmailNotifications(userId, since, userEmail, send);

          const docs: Array<{
            googleDocId: string; title: string; mimeType: string; driveUrl: string;
            role: string; isNew: boolean;
            accessState?: string; notes?: string; emailDate?: string;
          }> = gmailDocs.map(d => ({
            googleDocId: d.googleDocId,
            title: d.title,
            mimeType: d.mimeType,
            driveUrl: d.driveUrl,
            role: d.role,
            isNew: !existingDocIds.has(d.googleDocId),
          }));

          // Include inaccessible docs (permission denied / not found) so they can be loaded
          for (const d of inaccessibleDocs) {
            if (!existingDocIds.has(d.googleDocId)) {
              docs.push({
                googleDocId: d.googleDocId,
                title: d.title,
                mimeType: "",
                driveUrl: driveUrlFor(d.googleDocId),
                role: "REVIEWER",
                isNew: true,
                accessState: d.accessState,
                notes: d.notes,
                emailDate: d.emailDate.toISOString(),
              });
            }
          }

          const existingCount = docs.filter(d => !d.isNew).length;
          const totalDocs = gmailDocs.length + inaccessibleDocs.length;
          logInfo(`[Scan] Gmail scan found ${gmailDocs.length} accessible docs, ${inaccessibleDocs.length} inaccessible, ${existingCount} existing, ${errorCount} errors`);

          return {
            total: totalDocs,
            existingCount,
            errorCount,
            docs,
          };
        } catch (err) {
          logError("[Scan] Gmail error:", err);
          throw err; // Re-throw to let createProgressStream handle SSE error event
        }
      }

      logInfo(`[Scan] Starting Drive scan: daysBack=${daysBack ?? "all"}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}`);

      try {
        const since = daysBack !== null
          ? new Date(Math.max(0, Date.now() - daysBack * 24 * 60 * 60 * 1000))
          : null;
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

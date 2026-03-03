import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, invalidGrantResponse } from "@/lib/google-drive";
import { scanGmailNotifications } from "@/lib/gmail";
import { parseLoadOptions } from "@/lib/load-options";
import { logError, logInfo } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

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

  const existingDocIds = new Set(
    (await prisma.doc.findMany({
      where: { userId },
      select: { googleDocId: true },
    })).map((d) => d.googleDocId)
  );

  if (source === "gmail") {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    logInfo(`[Scan] Starting Gmail scan: daysBack=${daysBack}, since=${since.toISOString()}`);

    try {
      const { docs: gmailDocs, errorCount } = await scanGmailNotifications(userId, since);

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

      return NextResponse.json({
        total: gmailDocs.length,
        existingCount,
        errorCount,
        docs,
      });
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      logError("[Scan] Gmail error:", err);
      return NextResponse.json({ error: "Failed to scan Gmail" }, { status: 502 });
    }
  }

  logInfo(`[Scan] Starting Drive scan: daysBack=${daysBack}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}`);

  try {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const driveDocs = await listRecentDocs(userId, since, { ownership, includeSharedDrives });

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

    return NextResponse.json({
      total: driveDocs.length,
      existingCount,
      docs,
    });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError("[Scan] Drive error:", err);
    return NextResponse.json({ error: "Failed to scan Google Drive" }, { status: 502 });
  }
  });
}

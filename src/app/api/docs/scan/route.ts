import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, invalidGrantResponse } from "@/lib/google-drive";
import { parseLoadOptions } from "@/lib/load-options";

export async function POST(req: NextRequest) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const { daysBack, ownership, includeSharedDrives } = parseLoadOptions(body);

  console.log(`[Scan] Starting scan: daysBack=${daysBack}, ownership=${ownership}, includeSharedDrives=${includeSharedDrives}`);

  try {
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const driveDocs = await listRecentDocs(userId, since, { ownership, includeSharedDrives });

    const existingDocIds = new Set(
      (await prisma.doc.findMany({
        where: { userId },
        select: { googleDocId: true },
      })).map((d) => d.googleDocId)
    );

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
    console.log(`[Scan] Found ${driveDocs.length} total docs, ${driveDocs.length - existingCount} new`);

    return NextResponse.json({
      total: driveDocs.length,
      existingCount,
      docs,
    });
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    console.error("[Scan] Drive error:", err);
    return NextResponse.json({ error: "Failed to scan Google Drive" }, { status: 502 });
  }
}

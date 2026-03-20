import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { getDriveClient, createDriveService } from "@/lib/google-drive";
import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import pLimit from "p-limit";

/**
 * POST /api/docs/titles
 * Body: { googleDocIds: string[] }
 *
 * Fetches current titles from Google Drive for the given doc IDs.
 * Returns { [googleDocId]: title }. For docs that fail to fetch from Drive
 * (e.g. inaccessible), falls back to the title stored in the database.
 */
export async function POST(req: NextRequest) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const googleDocIds = Array.isArray(body.googleDocIds)
      ? (body.googleDocIds as unknown[]).filter((id): id is string => typeof id === "string")
      : [];

    if (googleDocIds.length === 0) {
      return NextResponse.json({});
    }

    // Cap at 100 to prevent abuse
    if (googleDocIds.length > 100) {
      return NextResponse.json({ error: "Too many IDs (max 100)" }, { status: 400 });
    }

    const idSummary = googleDocIds.length <= 1
      ? googleDocIds[0] ?? ""
      : `${googleDocIds[0]} (plus ${googleDocIds.length - 1} more)`;
    logInfo(`[Titles] Fetching ${googleDocIds.length} titles: ${idSummary}`);

    const auth = await getDriveClient(userId);
    const drive = createDriveService(auth);
    const limit = pLimit(10);

    const titles: Record<string, string> = {};
    const failedIds: string[] = [];

    await Promise.all(
      googleDocIds.map((id) =>
        limit(async () => {
          try {
            const res = await drive.files.get({
              fileId: id,
              fields: "id, name",
              supportsAllDrives: true,
            });
            const name = res.data.name;
            if (name) {
              titles[id] = name;
            }
          } catch (err: unknown) {
            const code = (err as { code?: number | string })?.code;
            logWarning(`[Titles] ${id} → error ${code ?? "unknown"}`);
            failedIds.push(id);
          }
        })
      )
    );

    // Fall back to DB titles for docs we couldn't fetch from Drive (e.g. inaccessible)
    if (failedIds.length > 0) {
      const dbDocs = await prisma.doc.findMany({
        where: { userId, googleDocId: { in: failedIds }, title: { not: "" } },
        select: { googleDocId: true, title: true },
      });
      for (const doc of dbDocs) {
        titles[doc.googleDocId] = doc.title;
      }
    }

    return NextResponse.json(titles);
  });
}

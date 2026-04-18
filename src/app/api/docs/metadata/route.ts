import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { getDriveClient, createDriveService, getDriveErrorCode } from "@/lib/google-drive";
import { OFFLINE_MODE } from "@/lib/offline";
import { prisma } from "@/lib/prisma";
import { logInfo, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import pLimit from "p-limit";

export interface DocMetadataEntry {
  title: string;
  owner: string | null;
}

/**
 * POST /api/docs/metadata
 * Body: { googleDocIds: string[] }
 *
 * Fetches current titles and owners from Google Drive for the given doc IDs.
 * Returns { [googleDocId]: { title, owner } }. For docs that fail to fetch
 * from Drive (e.g. inaccessible), falls back to the title stored in the
 * database (owner will be null since it's no longer stored in the DB).
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

    // In offline mode, skip Drive and fall back to DB titles only
    if (OFFLINE_MODE) {
      logWarning(`[Metadata] Offline mode — skipping Drive fetch for ${googleDocIds.length} docs, using DB titles`);
      const dbDocs = await prisma.doc.findMany({
        where: { userId, googleDocId: { in: googleDocIds }, title: { not: "" } },
        select: { googleDocId: true, title: true },
      });
      const metadata: Record<string, DocMetadataEntry> = {};
      for (const doc of dbDocs) {
        metadata[doc.googleDocId] = { title: doc.title, owner: null };
      }
      return NextResponse.json(metadata);
    }

    const idSummary = googleDocIds.length <= 1
      ? googleDocIds[0] ?? ""
      : `${googleDocIds[0]} (plus ${googleDocIds.length - 1} more)`;
    logInfo(`[Metadata] Fetching ${googleDocIds.length} doc metadata: ${idSummary}`);

    const auth = await getDriveClient(userId);
    const drive = createDriveService(auth);
    const limit = pLimit(10);

    const metadata: Record<string, DocMetadataEntry> = {};
    const failedIds: string[] = [];

    await Promise.all(
      googleDocIds.map((id) =>
        limit(async () => {
          try {
            const res = await drive.files.get({
              fileId: id,
              fields: "id, name, owners(displayName)",
              supportsAllDrives: true,
            });
            const name = res.data.name;
            if (name) {
              metadata[id] = {
                title: name,
                owner: res.data.owners?.[0]?.displayName ?? null,
              };
            }
          } catch (err: unknown) {
            logWarning(`[Metadata] ${id} → error ${getDriveErrorCode(err) ?? "unknown"}`);
            failedIds.push(id);
          }
        })
      )
    );

    // Fall back to DB titles for docs we couldn't fetch from Drive (e.g. inaccessible).
    // Owner is not stored in DB, so fallback entries have owner: null.
    if (failedIds.length > 0) {
      const dbDocs = await prisma.doc.findMany({
        where: { userId, googleDocId: { in: failedIds }, title: { not: "" } },
        select: { googleDocId: true, title: true },
      });
      for (const doc of dbDocs) {
        metadata[doc.googleDocId] = { title: doc.title, owner: null };
      }
    }

    return NextResponse.json(metadata);
  });
}

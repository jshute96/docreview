import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { getDriveClient, createDriveService } from "@/lib/google-drive";
import { logInfo, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";
import pLimit from "p-limit";

/**
 * GET /api/docs/titles?googleDocIds=id1,id2,...
 *
 * Fetches current titles from Google Drive for the given doc IDs.
 * Returns { [googleDocId]: title } for docs that were successfully fetched.
 * Docs that are inaccessible or errored are omitted from the response.
 */
export async function GET(req: NextRequest) {
  return runWithRequestId("GET", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("googleDocIds") ?? "";
    const googleDocIds = idsParam.split(",").filter(Boolean);

    if (googleDocIds.length === 0) {
      return NextResponse.json({});
    }

    // Cap at 100 to prevent abuse
    if (googleDocIds.length > 100) {
      return NextResponse.json({ error: "Too many IDs (max 100)" }, { status: 400 });
    }

    const auth = await getDriveClient(userId);
    const drive = createDriveService(auth);
    const limit = pLimit(10);

    const titles: Record<string, string> = {};

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
          }
        })
      )
    );

    return NextResponse.json(titles);
  });
}

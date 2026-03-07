import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, invalidGrantResponse } from "@/lib/google-drive";
import { runWithRequestId } from "@/lib/request-context";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("PUT", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const { docId } = await params;

    const doc = await prisma.doc.findUnique({ where: { docId } });
    if (!doc || doc.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { viewedByMeTime } = body as { viewedByMeTime?: string };
    if (!viewedByMeTime || isNaN(new Date(viewedByMeTime).getTime())) {
      return NextResponse.json({ error: "Invalid timestamp" }, { status: 400 });
    }

    let driveAuth;
    try {
      driveAuth = await getDriveClient(userId);
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      const message = err instanceof Error ? err.message : "Failed to connect to Google Drive";
      return NextResponse.json({ error: message }, { status: 502 });
    }

    try {
      const drive = createDriveService(driveAuth);
      const res = await drive.files.update({
        fileId: doc.googleDocId,
        requestBody: { viewedByMeTime: new Date(viewedByMeTime).toISOString() },
        fields: "viewedByMeTime",
      });
      return NextResponse.json({ viewedByMeTime: res.data.viewedByMeTime });
    } catch (err) {
      const reauth = invalidGrantResponse(err);
      if (reauth) return reauth;
      const message = err instanceof Error ? err.message : "Failed to update viewed time";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  });
}

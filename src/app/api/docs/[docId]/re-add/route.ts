import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { addDoc } from "@/lib/add-doc";
import { runWithRequestId } from "@/lib/request-context";
import { GoogleMimeType } from "@/lib/mime-types";
import { DocStatus } from "@prisma/client";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", req, async () => {
    const session = await getValidSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;
    const userEmail = session.user.email ?? undefined;
    const { docId: oldDocId } = await params;

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const { labelIds = [], isStarred, notes, status } = body as {
      labelIds?: string[];
      isStarred?: boolean;
      notes?: string;
      status?: DocStatus;
    };

    // Find old doc
    const oldDoc = await prisma.doc.findUnique({
      where: { docId: oldDocId },
    });

    if (!oldDoc || oldDoc.userId !== userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return addDoc({
      userId,
      userEmail,
      googleDocId: oldDoc.googleDocId,
      labelIds,
      isStarred,
      notes,
      status,
      deleteDocId: oldDocId,
      fallback: {
        title: oldDoc.title || "Unknown title",
        driveUrl: oldDoc.driveUrl,
        mimeType: oldDoc.mimeType ?? GoogleMimeType.Doc,
        role: oldDoc.role,
        lastModifiedInDrive: oldDoc.lastModifiedInDrive,
        createdTimeInDrive: oldDoc.createdTimeInDrive,
      },
    });
  });
}

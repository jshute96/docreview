import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs } from "@/lib/google-drive";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "true";
  const labelIds = searchParams.getAll("labelId");

  const docs = await prisma.doc.findMany({
    where: {
      userId,
      ...(includeArchived ? {} : { status: "ACTIVE" }),
      ...(labelIds.length > 0
        ? { labels: { some: { labelId: { in: labelIds } } } }
        : {}),
    },
    include: {
      labels: { include: { label: true } },
    },
    orderBy: { lastModifiedInDrive: "desc" },
  });

  return NextResponse.json(docs);
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let driveDocs;
  try {
    driveDocs = await listRecentDocs(userId);
  } catch (err) {
    console.error("Drive error:", err);
    return NextResponse.json(
      { error: "Failed to fetch from Google Drive" },
      { status: 502 }
    );
  }

  let added = 0;
  let updated = 0;

  for (const doc of driveDocs) {
    const existing = await prisma.doc.findUnique({
      where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
    });

    if (existing) {
      const changed =
        existing.title !== doc.title ||
        existing.driveUrl !== doc.driveUrl ||
        existing.lastModifiedInDrive?.getTime() !== doc.lastModifiedInDrive?.getTime();
      if (changed) {
        await prisma.doc.update({
          where: { id: existing.id },
          data: {
            title: doc.title,
            driveUrl: doc.driveUrl,
            lastModifiedInDrive: doc.lastModifiedInDrive,
          },
        });
        updated++;
      }
    } else {
      await prisma.doc.create({
        data: {
          userId,
          googleDocId: doc.googleDocId,
          title: doc.title,
          driveUrl: doc.driveUrl,
          role: doc.role,
          lastModifiedInDrive: doc.lastModifiedInDrive,
        },
      });
      added++;
    }
  }

  return NextResponse.json({ added, updated, total: driveDocs.length });
}

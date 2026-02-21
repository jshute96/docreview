import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { listRecentDocs, findDeletedDocIds } from "@/lib/google-drive";

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
  let deleted = 0;

  const driveDocIds = new Set(driveDocs.map((d) => d.googleDocId));

  for (const doc of driveDocs) {
    const existing = await prisma.doc.findUnique({
      where: { userId_googleDocId: { userId, googleDocId: doc.googleDocId } },
    });

    if (existing) {
      const changed =
        existing.title !== doc.title ||
        existing.driveUrl !== doc.driveUrl ||
        existing.lastModifiedInDrive?.getTime() !== doc.lastModifiedInDrive?.getTime() ||
        existing.isDeleted;
      if (changed) {
        await prisma.doc.update({
          where: { id: existing.id },
          data: {
            title: doc.title,
            driveUrl: doc.driveUrl,
            lastModifiedInDrive: doc.lastModifiedInDrive,
            isDeleted: false,
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

  // Check active docs that didn't appear in Drive results — one list call, not N gets
  const missingDocs = await prisma.doc.findMany({
    where: {
      userId,
      isDeleted: false,
      status: "ACTIVE",
      googleDocId: { notIn: [...driveDocIds] },
    },
    select: { id: true, googleDocId: true },
  });

  if (missingDocs.length > 0) {
    const deletedIds = await findDeletedDocIds(userId, missingDocs.map((d) => d.googleDocId));
    for (const doc of missingDocs) {
      if (deletedIds.has(doc.googleDocId)) {
        await prisma.doc.update({ where: { id: doc.id }, data: { isDeleted: true } });
        deleted++;
      }
    }
  }

  return NextResponse.json({ added, updated, deleted, total: driveDocs.length });
}

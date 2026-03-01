import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { DocRole, Prisma } from "@prisma/client";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import { BulkEditState } from "@/lib/bulk-edit";

export async function PATCH(req: NextRequest) {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { docIds, role, labelUpdates, appendNotes } = body as {
    docIds: string[];
    role: BulkEditState;
    labelUpdates: Record<string, BulkEditState>;
    appendNotes?: string;
  };

  if (!Array.isArray(docIds) || docIds.length === 0) {
    return NextResponse.json({ error: "No docIds provided" }, { status: 400 });
  }

  const updatedDocs = await Promise.all(
    docIds.map(async (id) => {
      const doc = await prisma.doc.findUnique({
        where: { id, userId },
        include: { 
          ...docWithCountsInclude,
        },
      });
      if (!doc) return null;

      const data: Prisma.DocUpdateInput = {};
      if (role === "set") data.role = DocRole.AUTHOR;
      else if (role === "clear") data.role = DocRole.REVIEWER;

      if (appendNotes && appendNotes.trim().length > 0) {
        const currentNotes = doc.notes ?? "";
        let newNotes = currentNotes;
        if (newNotes.length > 0 && !newNotes.endsWith("\n")) {
          newNotes += "\n";
        }
        newNotes += appendNotes;
        data.notes = newNotes;
      }

      const currentLabelIds = new Set(doc.labels.map((l) => l.labelId));
      const labelsToCreate: { labelId: string }[] = [];
      const labelsToDelete: string[] = [];

      for (const [labelId, state] of Object.entries(labelUpdates)) {
        if (state === "set" && !currentLabelIds.has(labelId)) {
          labelsToCreate.push({ labelId });
        } else if (state === "clear" && currentLabelIds.has(labelId)) {
          labelsToDelete.push(labelId);
        }
      }

      // No-op protection: Check if absolutely nothing has changed for this document
      // (role, notes, and labels all match the current state). If it's a no-op, 
      // we skip the database 'update' call entirely to avoid unnecessary transactions,
      // row locks, and WAL overhead.
      if (
        Object.keys(data).length === 0 &&
        labelsToCreate.length === 0 &&
        labelsToDelete.length === 0
      ) {
        // Return 'doc' directly because we included counts in the initial fetch.
        return doc;
      }

      return prisma.doc.update({
        where: { id },
        data: {
          ...data,
          labels: {
            create: labelsToCreate,
            deleteMany: {
              labelId: { in: labelsToDelete },
            },
          },
        },
        include: docWithCountsInclude,
      });
    })
  );

  return NextResponse.json(
    updatedDocs.filter((d) => d !== null).map(withCommentCounts)
  );
}

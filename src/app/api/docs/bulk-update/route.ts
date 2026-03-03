import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { DocRole, DocStatus, Prisma } from "@prisma/client";
import { docWithCountsInclude, withCommentCounts } from "@/lib/doc-queries";
import type { BulkEditState } from "@/lib/bulk-edit";
import { runWithRequestId } from "@/lib/request-context";

const VALID_BULK_STATES = new Set(["as-is", "set", "clear"]);

export async function PATCH(req: NextRequest) {
  return runWithRequestId("PATCH", req, async () => {
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

  const { docIds, role, status, labelUpdates, appendNotes } = body as {
    docIds: unknown;
    role: unknown;
    status: unknown;
    labelUpdates: unknown;
    appendNotes?: unknown;
  };

  // Runtime validation
  if (!Array.isArray(docIds) || docIds.length === 0) {
    return NextResponse.json({ error: "No docIds provided" }, { status: 400 });
  }
  if (docIds.length > 500) {
    return NextResponse.json({ error: "Too many documents (max 500)" }, { status: 400 });
  }
  if (!docIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "Invalid docIds" }, { status: 400 });
  }
  if (typeof role !== "string" || !VALID_BULK_STATES.has(role)) {
    return NextResponse.json({ error: "Invalid role state" }, { status: 400 });
  }
  if (typeof status !== "string" || !VALID_BULK_STATES.has(status)) {
    return NextResponse.json({ error: "Invalid status state" }, { status: 400 });
  }
  if (
    typeof labelUpdates !== "object" ||
    labelUpdates === null ||
    Array.isArray(labelUpdates) ||
    !Object.values(labelUpdates as Record<string, unknown>).every(
      (v) => typeof v === "string" && VALID_BULK_STATES.has(v)
    )
  ) {
    return NextResponse.json({ error: "Invalid labelUpdates" }, { status: 400 });
  }
  if (appendNotes !== undefined && typeof appendNotes !== "string") {
    return NextResponse.json({ error: "Invalid appendNotes" }, { status: 400 });
  }

  const typedRole = role as BulkEditState;
  const typedStatus = status as BulkEditState;
  const typedLabelUpdates = labelUpdates as Record<string, BulkEditState>;
  const typedAppendNotes = appendNotes as string | undefined;

  // Batch read: fetch all docs at once instead of N+1
  const docs = await prisma.doc.findMany({
    where: { docId: { in: docIds as string[] }, userId },
    include: docWithCountsInclude,
  });
  const skipped = (docIds as string[]).length - docs.length;

  // Build all update operations
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  const updateOrder: string[] = [];

  for (const doc of docs) {
    const data: Prisma.DocUpdateInput = {};
    if (typedRole === "set") data.role = DocRole.AUTHOR;
    else if (typedRole === "clear") data.role = DocRole.REVIEWER;

    if (typedStatus === "set") data.status = DocStatus.INBOX;
    else if (typedStatus === "clear") data.status = DocStatus.ARCHIVED;

    if (typedAppendNotes && typedAppendNotes.trim().length > 0) {
      const currentNotes = doc.notes ?? "";
      let newNotes = currentNotes;
      if (newNotes.length > 0 && !newNotes.endsWith("\n")) {
        newNotes += "\n";
      }
      newNotes += typedAppendNotes;
      data.notes = newNotes;
    }

    const currentLabelIds = new Set(doc.labels.map((l) => l.labelId));
    const labelsToCreate: { labelId: string }[] = [];
    const labelsToDelete: string[] = [];

    for (const [labelId, state] of Object.entries(typedLabelUpdates)) {
      if (state === "set" && !currentLabelIds.has(labelId)) {
        labelsToCreate.push({ labelId });
      } else if (state === "clear" && currentLabelIds.has(labelId)) {
        labelsToDelete.push(labelId);
      }
    }

    // No-op protection: skip if nothing changed
    if (
      Object.keys(data).length === 0 &&
      labelsToCreate.length === 0 &&
      labelsToDelete.length === 0
    ) {
      continue;
    }

    updateOrder.push(doc.docId);
    updates.push(
      prisma.doc.update({
        where: { docId: doc.docId },
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
      })
    );
  }

  // Execute all writes in a single transaction
  const results = updates.length > 0
    ? await prisma.$transaction(updates)
    : [];

  // Build result map from updated docs
  const updatedMap = new Map<string, unknown>();
  for (let i = 0; i < updateOrder.length; i++) {
    updatedMap.set(updateOrder[i], results[i]);
  }

  // Return all docs (updated ones from transaction, unchanged ones from initial read)
  const allDocs = docs.map((d) => {
    const updated = updatedMap.get(d.docId) as typeof d | undefined;
    return withCommentCounts(updated ?? d);
  });

  return NextResponse.json({ docs: allDocs, skipped });
  });
}

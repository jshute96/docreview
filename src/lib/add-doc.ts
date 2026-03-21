/**
 * Shared logic for adding a doc (used by both add and re-add routes).
 * Fetches Drive metadata, creates the doc record, syncs comments.
 * If deleteDocId is provided, deletes that doc first (for re-add).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  SUPPORTED_MIME_TYPES,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { syncComments } from "@/lib/sync-comments";
import { docWithCountsInclude, withCommentCounts, stripServerOnly } from "@/lib/doc-queries";
import { logWarning } from "@/lib/log";

/** Fallback metadata used when Drive access is denied. */
export interface PermissionDeniedFallback {
  title: string;
  driveUrl: string;
  mimeType: string;
  role: "AUTHOR" | "REVIEWER";
  lastModifiedInDrive: Date | null;
  createdTimeInDrive: Date | null;
}

export interface AddDocParams {
  userId: string;
  userEmail?: string;
  googleDocId: string;
  labelIds: string[];
  isStarred?: boolean;
  notes?: string | null;
  status?: "INBOX" | "ARCHIVED";
  /** If set, delete this doc before creating (re-add, or replacing a denied row). */
  deleteDocId?: string;
  /** Metadata to use when Drive access fails. */
  fallback: PermissionDeniedFallback;
}

/** Validate that all labelIds belong to the given user. Returns an error response, or null if valid. */
export async function validateLabelOwnership(
  userId: string, labelIds: string[]
): Promise<NextResponse | null> {
  if (labelIds.length === 0) return null;
  const ownedLabels = await prisma.label.findMany({
    where: { labelId: { in: labelIds }, userId },
    select: { labelId: true },
  });
  if (ownedLabels.length !== labelIds.length) {
    return NextResponse.json({ error: "Invalid label" }, { status: 400 });
  }
  return null;
}

/** Validate common doc inputs for add/re-add. Returns an error response, or null if valid. */
export async function validateDocInputs(
  { userId, labelIds, status, isStarred }: {
    userId: string;
    labelIds: string[];
    status?: string;
    isStarred?: boolean;
  }
): Promise<NextResponse | null> {
  if (status !== undefined && status !== "INBOX" && status !== "ARCHIVED") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (isStarred !== undefined && typeof isStarred !== "boolean") {
    return NextResponse.json({ error: "Invalid isStarred" }, { status: 400 });
  }
  return validateLabelOwnership(userId, labelIds);
}

export async function addDoc(params: AddDocParams): Promise<NextResponse> {
  const {
    userId, userEmail, googleDocId, labelIds,
    isStarred, notes, status, deleteDocId, fallback,
  } = params;

  const validationError = await validateDocInputs({ userId, labelIds, status, isStarred });
  if (validationError) return validationError;

  // Try Drive API for fresh metadata
  let f;
  let driveAuth;
  let permissionDenied = false;
  try {
    driveAuth = await getDriveClient(userId);
    const drive = createDriveService(driveAuth);
    const res = await drive.files.get({
      fileId: googleDocId,
      fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
      supportsAllDrives: true,
    });
    f = res.data;
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const errStatus = (err as { status?: number }).status;
    logWarning(`[Drive] No access to ${googleDocId} (status ${errStatus ?? "?"})`);
    permissionDenied = true;
  }

  if (!permissionDenied) {
    if (f!.trashed) {
      return NextResponse.json({ error: "trashed" }, { status: 400 });
    }
    if (!f!.mimeType || !SUPPORTED_MIME_TYPES.has(f!.mimeType)) {
      return NextResponse.json({ error: "invalid_mime_type" }, { status: 400 });
    }
  }

  const isOwner = !permissionDenied && (f!.owners?.some((o) => o.me === true) ?? false);

  const docData = permissionDenied
    ? {
        title: fallback.title,
        driveUrl: fallback.driveUrl,
        mimeType: fallback.mimeType,
        role: fallback.role,
        lastModifiedInDrive: fallback.lastModifiedInDrive,
        createdTimeInDrive: fallback.createdTimeInDrive,
        accessState: "DENIED" as const,
      }
    : {
        title: f!.name ?? "",
        driveUrl: f!.webViewLink ?? `https://docs.google.com/document/d/${googleDocId}/edit`,
        mimeType: f!.mimeType!,
        role: (isOwner ? "AUTHOR" : "REVIEWER") as "AUTHOR" | "REVIEWER",
        lastModifiedInDrive: f!.modifiedTime ? new Date(f!.modifiedTime) : null,
        createdTimeInDrive: f!.createdTime ? new Date(f!.createdTime) : null,
        accessState: "OK" as const,
      };

  // Transactional: optionally delete old doc, then create new one
  const newDoc = await prisma.$transaction(async (tx) => {
    if (deleteDocId) {
      await tx.doc.delete({ where: { docId: deleteDocId } });
    }
    return await tx.doc.create({
      data: {
        userId,
        googleDocId,
        ...docData,
        status: status ?? "INBOX",
        notes: notes || null,
        isStarred: isStarred ?? false,
        labels: {
          create: labelIds.map((labelId: string) => ({ labelId })),
        },
      },
    });
  });

  if (!permissionDenied) {
    await syncComments(newDoc, driveAuth!, userEmail);
  }

  const result = await prisma.doc.findUnique({
    where: { docId: newDoc.docId },
    include: docWithCountsInclude,
  });

  return NextResponse.json(result ? stripServerOnly(withCommentCounts(result)) : result, { status: 201 });
}

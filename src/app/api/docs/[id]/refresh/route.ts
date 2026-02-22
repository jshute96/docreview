import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getDriveClient, fetchComments, fetchSuggestions, type DriveSuggestion } from "@/lib/google-drive";
import type { Doc } from "@prisma/client";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";

async function syncComments(
  doc: Doc,
  driveAuth: Awaited<ReturnType<typeof getDriveClient>>
): Promise<void> {
  // Always do a full scan (no since filter). The user is explicitly clicking Refresh,
  // and suggestions only appear in full scans (Drive API filters them out with since).
  let comments;
  try {
    comments = await fetchComments(driveAuth, doc.googleDocId);
  } catch (err) {
    console.error(`[Comments] failed for ${doc.googleDocId}:`, err);
    return;
  }

  const hasDriveSuggestions = comments.some((c) => c.isSuggestion);

  // For Drive-surfaced suggestions (kix.xxx anchor, JSON anchor with si= field):
  // cross-reference with Docs API to get INSERT/DELETE/EDIT type.
  const docsTypeMap = new Map<string, "INSERT" | "DELETE" | "EDIT">();
  // Also fetch full Docs suggestions now so we can run the Docs sync in one pass.
  let docsSuggestionsForSync: DriveSuggestion[] = [];
  if (doc.mimeType === DOCS_MIME_TYPE) {
    try {
      const docsSuggestions = await fetchSuggestions(driveAuth, doc.googleDocId);
      for (const s of docsSuggestions) {
        docsTypeMap.set(s.id, s.suggestionType);
      }
      docsSuggestionsForSync = docsSuggestions;
    } catch (err) {
      console.error(`[Suggestions] type lookup failed for ${doc.googleDocId}:`, err);
    }
  }

  for (const c of comments) {
    const isSuggestion = c.isSuggestion;
    const suggestionType = isSuggestion && c.docsSuggestionId
      ? docsTypeMap.get(c.docsSuggestionId) ?? null
      : null;

    const existing = await prisma.comment.findUnique({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: c.id } },
    });

    if (!existing) {
      // Suggestions are auto-archived when resolved (accepted/rejected)
      const status = c.resolved ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.create({
        data: {
          docId: doc.id,
          googleCommentId: c.id,
          type: isSuggestion ? "SUGGESTION" : "COMMENT",
          suggestionType,
          resolved: c.resolved,
          isMine: c.isMine,
          iParticipated: c.iParticipated,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
    } else {
      if (existing.status === "MUTED") {
        await prisma.comment.update({
          where: { id: existing.id },
          data: {
            resolved: c.resolved,
            iParticipated: c.iParticipated,
            suggestionType: suggestionType ?? existing.suggestionType,
            driveCreatedAt: c.driveCreatedAt,
            driveModifiedAt: c.driveModifiedAt,
            replyCount: c.replyCount,
          },
        });
        continue;
      }
      // For suggestions: auto-archive when resolved (accepted/rejected)
      const status = isSuggestion
        ? c.resolved ? "ARCHIVED" : existing.status
        : c.resolved && c.iResolvedIt ? "ARCHIVED" : "ACTIVE";
      await prisma.comment.update({
        where: { id: existing.id },
        data: {
          resolved: c.resolved,
          iParticipated: c.iParticipated,
          suggestionType: suggestionType ?? existing.suggestionType,
          status,
          driveCreatedAt: c.driveCreatedAt,
          driveModifiedAt: c.driveModifiedAt,
          replyCount: c.replyCount,
        },
      });
    }
  }

  await prisma.doc.update({
    where: { id: doc.id },
    data: { commentsLastSyncedAt: new Date() },
  });

  // Docs API sync: ensures ALL pending suggestions are tracked, even those Drive API
  // doesn't surface as comment threads (Drive only returns a subset as comments.list entries).
  // AAAB0xxx records from Drive API above coexist with suggest.xxx records here.
  if (doc.mimeType !== DOCS_MIME_TYPE || docsSuggestionsForSync.length === 0) return;

  const liveDocsIds = new Set<string>();
  for (const s of docsSuggestionsForSync) {
    liveDocsIds.add(s.id);
    await prisma.comment.upsert({
      where: { docId_googleCommentId: { docId: doc.id, googleCommentId: s.id } },
      create: {
        docId: doc.id,
        googleCommentId: s.id,
        type: "SUGGESTION",
        suggestionType: s.suggestionType,
        resolved: false,
        status: "ACTIVE",
      },
      update: {
        suggestionType: s.suggestionType,
      },
    });
  }

  // Mark suggest.xxx suggestions no longer in the document as resolved.
  // Skip AAAB0xxx records — those are managed by the Drive API sync above.
  const activeSuggestions = await prisma.comment.findMany({
    where: { docId: doc.id, type: "SUGGESTION", resolved: false },
  });
  for (const s of activeSuggestions) {
    if (s.googleCommentId.startsWith("AAAB")) continue;
    if (!liveDocsIds.has(s.googleCommentId)) {
      await prisma.comment.update({
        where: { id: s.id },
        data: { resolved: true, status: s.status === "ACTIVE" ? "ARCHIVED" : s.status },
      });
    }
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { id } = await params;

  const doc = await prisma.doc.findUnique({ where: { id } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    console.error("Drive auth error:", err);
    return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
  }

  await syncComments(doc, driveAuth);

  const updated = await prisma.doc.findUnique({
    where: { id },
    include: {
      labels: { include: { label: true } },
      comments: { orderBy: { driveCreatedAt: "asc" } },
    },
  });

  return NextResponse.json(updated);
}

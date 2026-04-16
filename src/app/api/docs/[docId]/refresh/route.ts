import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, invalidGrantResponse, fetchCommentData, fetchDocData, fetchFileTextViaExport, driveUrlFor } from "@/lib/google-drive";
import type { ThreadMap, SuggestionContent, DriveSuggestion } from "@/lib/google-drive";
import { upsertDocsAndSyncComments } from "@/lib/refresh";
import { docWithCommentsInclude, stripServerOnly } from "@/lib/doc-queries";
import { logError, logWarning } from "@/lib/log";
import { runWithRequestId } from "@/lib/request-context";

const DOCS_MIME_TYPE = "application/vnd.google-apps.document";
const SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ docId: string }> }
) {
  return runWithRequestId("POST", _req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email ?? undefined;
  const { docId } = await params;

  const doc = await prisma.doc.findUnique({ where: { docId } });
  if (!doc || doc.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let driveAuth;
  try {
    driveAuth = await getDriveClient(userId);
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    logError("[Refresh] Drive auth error:", err);
    return NextResponse.json({ error: "Failed to connect to Google Drive" }, { status: 502 });
  }

  // Update file metadata first so lastModifiedInDrive is current before comment sync.
  let driveDoc;
  let viewedByMeTime: string | null = null;
  try {
    const drive = createDriveService(driveAuth);
    const fileRes = await drive.files.get({
      fileId: doc.googleDocId,
      fields: "id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed, viewedByMeTime",
      supportsAllDrives: true,
    });
    const f = fileRes.data;
    viewedByMeTime = f.viewedByMeTime ?? null;
    const isOwner = f.owners?.some((o) => o.me === true) ?? false;
    driveDoc = {
      googleDocId: f.id!,
      title: f.name!,
      driveUrl: driveUrlFor(f.id!, f.webViewLink),
      mimeType: f.mimeType!,
      role: isOwner ? "AUTHOR" : "REVIEWER",
      lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : null,
      createdTimeInDrive: f.createdTime ? new Date(f.createdTime) : null,
      trashed: f.trashed === true,
    } as any;
  } catch (err: unknown) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    const code = (err as { code?: number })?.code;
    if (code === 404) {
      // 404 is ambiguous for DENIED docs (Google returns 404 for permission denied too)
      if (doc.accessState !== "DENIED") {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) not found (code 404)`);
        await prisma.doc.update({ where: { docId }, data: { accessState: "NOT_FOUND" } });
      } else {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) still inaccessible (code 404, keeping DENIED)`);
      }
    } else if (code === 403) {
      logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) permission denied (code 403)`);
      await prisma.doc.update({ where: { docId }, data: { accessState: "DENIED" } });
    } else {
      logError("[Refresh] Failed to refresh file metadata:", err);
    }
  }

  let threadMap: ThreadMap | undefined;
  let uiContent: { suggestions: Record<string, SuggestionContent>; documentText: string | null } | null = null;

  if (driveDoc) {
    if (driveDoc.trashed) {
      await prisma.doc.update({ where: { docId }, data: { accessState: "TRASHED" } });
    } else {
      // Fetch comments+threads and doc content in parallel — each API is called
      // once, then the results feed both the DB sync and the client response.
      const mimeType = driveDoc.mimeType ?? doc.mimeType;
      const [commentResult, docDataResult] = await Promise.all([
        fetchCommentData(driveAuth, doc.googleDocId, { sync: true, threads: true, userEmail }).catch((err) => {
          logWarning("[Refresh] fetchCommentData failed, will fall back to individual fetches:", err);
          return null;
        }),
        (mimeType === DOCS_MIME_TYPE
          ? fetchDocData(driveAuth, doc.googleDocId).catch((err) => {
              logWarning("[Refresh] fetchDocData failed:", err);
              return null;
            })
          : mimeType === SLIDES_MIME_TYPE
            ? fetchFileTextViaExport(driveAuth, doc.googleDocId).then(
                (text) => ({ suggestions: [] as DriveSuggestion[], suggestionContent: {} as Record<string, SuggestionContent>, documentText: text }),
              ).catch(() => null)
            : Promise.resolve(null)),
      ]);

      // Pass pre-fetched data to the sync so it doesn't re-fetch from Drive.
      await upsertDocsAndSyncComments(userId, userEmail, [driveDoc], {
        existingDocIds: new Set([doc.googleDocId]),
        mode: "selected",
        docId,
        prefetched: {
          ...(commentResult?.comments ? { comments: commentResult.comments } : {}),
          ...(docDataResult ? { suggestions: docDataResult.suggestions } : {}),
        },
      });

      // Build thread map keyed by thread ID for the client response.
      if (commentResult?.threads) {
        threadMap = {};
        for (const t of commentResult.threads) threadMap[t.id] = t;
      }
      if (docDataResult) {
        uiContent = { suggestions: docDataResult.suggestionContent, documentText: docDataResult.documentText };
      }
    }
  }

  const updated = await prisma.doc.findUnique({
    where: { docId },
    include: docWithCommentsInclude,
  });

  const docData = updated ? stripServerOnly(updated) : updated;
  return NextResponse.json({
    ...docData,
    // Extra fields so the client can skip separate /comments + /content fetches
    ...(threadMap !== undefined && { threads: threadMap }),
    viewedByMeTime,
    ...(uiContent && {
      suggestionContent: uiContent.suggestions,
      ...(uiContent.documentText != null && { documentText: uiContent.documentText }),
    }),
  });
  });
}

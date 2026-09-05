import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { getDriveClient, createDriveService, invalidGrantResponse, fetchCommentData, fetchDocData, fetchFileTextViaExport, driveUrlFor, isDriveErrorCode, commentsAreHidden, COMMENT_VISIBILITY_FIELDS } from "@/lib/google-drive";
import type { ThreadMap, SuggestionContent, DriveSuggestion, DriveDoc, DocDataResult } from "@/lib/google-drive";
import { upsertDocsAndSyncComments } from "@/lib/refresh";
import { docWithCommentsInclude, stripServerOnly } from "@/lib/doc-queries";
import { logError, logWarning } from "@/lib/log";
import { GoogleMimeType } from "@/lib/mime-types";
import { runWithRequestId } from "@/lib/request-context";
import { AccessState, DocRole } from "@prisma/client";

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
  // `trashed` is carried alongside the DriveDoc fields for the local trashed-state check;
  // upsertDocsAndSyncComments only reads the DriveDoc fields.
  let driveDoc: (DriveDoc & { trashed: boolean }) | undefined;
  let viewedByMeTime: string | null = null;
  // Undefined when the response carried no `capabilities` object.
  let canComment: boolean | null | undefined;
  try {
    const drive = createDriveService(driveAuth);
    const fileRes = await drive.files.get({
      fileId: doc.googleDocId,
      fields: `id, name, mimeType, webViewLink, modifiedTime, createdTime, owners(me, displayName), trashed, viewedByMeTime, ${COMMENT_VISIBILITY_FIELDS}`,
      supportsAllDrives: true,
    });
    const f = fileRes.data;
    viewedByMeTime = f.viewedByMeTime ?? null;
    canComment = f.capabilities?.canComment;
    const isOwner = f.owners?.some((o) => o.me === true) ?? false;
    driveDoc = {
      googleDocId: f.id!,
      title: f.name!,
      driveUrl: driveUrlFor(f.id!, f.webViewLink),
      mimeType: f.mimeType!,
      role: isOwner ? DocRole.AUTHOR : DocRole.REVIEWER,
      lastModifiedInDrive: f.modifiedTime ? new Date(f.modifiedTime) : null,
      createdTimeInDrive: f.createdTime ? new Date(f.createdTime) : null,
      trashed: f.trashed === true,
    };
  } catch (err: unknown) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    if (isDriveErrorCode(err, 404)) {
      // 404 is ambiguous for DENIED docs (Google returns 404 for permission denied too)
      if (doc.accessState !== AccessState.DENIED) {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) not found (code 404)`);
        await prisma.doc.update({ where: { docId }, data: { accessState: AccessState.NOT_FOUND } });
      } else {
        logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) still inaccessible (code 404, keeping DENIED)`);
      }
    } else if (isDriveErrorCode(err, 403)) {
      logWarning(`[Refresh] doc ${doc.docId} (${doc.googleDocId}) permission denied (code 403)`);
      await prisma.doc.update({ where: { docId }, data: { accessState: AccessState.DENIED } });
    } else {
      logError("[Refresh] Failed to refresh file metadata:", err);
    }
  }

  let threadMap: ThreadMap | undefined;
  // Whether Drive refused comment access on this pass. Reported to the client so
  // a refresh can both raise and clear the "comments not visible" state.
  let commentsForbidden: boolean | undefined;
  let uiContent: { suggestions: Record<string, SuggestionContent>; documentText: string | null } | null = null;

  if (driveDoc) {
    if (driveDoc.trashed) {
      await prisma.doc.update({ where: { docId }, data: { accessState: AccessState.TRASHED } });
    } else {
      // Fetch comments+threads and doc content in parallel — each API is called
      // once, then the results feed both the DB sync and the client response.
      const mimeType = driveDoc.mimeType ?? doc.mimeType;
      const [commentResult, docDataResult] = await Promise.all([
        fetchCommentData(driveAuth, doc.googleDocId, { sync: true, threads: true, userEmail }).catch((err) => {
          // A 403 propagates here rather than being swallowed (that only happens
          // on the threads-only path), so record it for the response.
          if (isDriveErrorCode(err, 403)) {
            logWarning(`[Refresh] no comment access for doc ${docId} (code 403)`);
            commentsForbidden = true;
            return null;
          }
          logWarning("[Refresh] fetchCommentData failed, will fall back to individual fetches:", err);
          return null;
        }),
        (mimeType === GoogleMimeType.Doc
          ? fetchDocData(driveAuth, doc.googleDocId).catch((err) => {
              logWarning("[Refresh] fetchDocData failed:", err);
              return null;
            })
          : mimeType === GoogleMimeType.Slides
            ? fetchFileTextViaExport(driveAuth, doc.googleDocId).then(
                // The export reads text only. Slides have no suggestions and the
                // sync skips its suggestion phase for them anyway, but the flag
                // keeps the empty list from being read as authoritative if the
                // stored mimeType and Drive's ever disagree.
                (text): DocDataResult => ({
                  suggestions: [] as DriveSuggestion[],
                  suggestionContent: {} as Record<string, SuggestionContent>,
                  documentText: text,
                  suggestionsUnavailable: "error",
                }),
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
          // The flag must travel with the list: an empty `suggestions` from a
          // doc we couldn't read must not look like a doc with none left open.
          ...(docDataResult
            ? {
                suggestions: docDataResult.suggestions,
                ...(docDataResult.suggestionsUnavailable
                  ? { suggestionsUnavailable: docDataResult.suggestionsUnavailable }
                  : {}),
              }
            : {}),
        },
      });

      // `permissionDenied` is always undefined here (a sync lets the 403 reach
      // the catch above) — passed so the rule stays in one place.
      if (commentResult) {
        commentsForbidden = commentsAreHidden({
          permissionDenied: commentResult.permissionDenied,
          canComment,
          threadCount: commentResult.threads?.length,
        });
      }
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
    ...(commentsForbidden !== undefined && { forbidden: commentsForbidden }),
    viewedByMeTime,
    ...(uiContent && {
      suggestionContent: uiContent.suggestions,
      ...(uiContent.documentText != null && { documentText: uiContent.documentText }),
    }),
  });
  });
}

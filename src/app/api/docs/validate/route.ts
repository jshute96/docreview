import { NextRequest, NextResponse } from "next/server";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import {
  getDriveClient,
  createDriveService,
  parseGoogleDocId,
  SUPPORTED_MIME_TYPES,
  invalidGrantResponse,
} from "@/lib/google-drive";
import { runWithRequestId } from "@/lib/request-context";
import { logInfo } from "@/lib/log";
import { looksLikeRedirectUrl } from "@/lib/url-utils";

/**
 * Try to resolve a shortened URL by following redirects server-side.
 * Returns the final URL if it redirected, or null if it failed or didn't redirect.
 * Uses `redirect: "follow"` with a short timeout. This won't work for shorteners
 * that require browser cookies/auth — those need the Chrome extension.
 */
async function tryResolveRedirect(url: string): Promise<string | null> {
  if (!looksLikeRedirectUrl(url)) return null;

  let fullUrl = url.trim();
  if (!/^https?:\/\//i.test(fullUrl)) {
    fullUrl = "http://" + fullUrl;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(fullUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Docreview/1.0" },
    });
    clearTimeout(timeout);

    // If we ended up at a different URL, return it.
    // If we landed on a Google sign-in page, the actual doc URL is in the
    // "continue" query parameter (server has no Google cookies).
    if (res.url && res.url !== fullUrl) {
      let resolved = res.url;
      try {
        const parsed = new URL(resolved);
        if (parsed.hostname === "accounts.google.com") {
          const cont = parsed.searchParams.get("continue");
          if (cont) resolved = cont;
        }
      } catch { /* use resolved as-is */ }
      logInfo("[redirect-resolve]", `${fullUrl} → ${resolved}`);
      return resolved;
    }
    logInfo("[redirect-resolve]", `${fullUrl} — no redirect`);
    return null;
  } catch (err) {
    logInfo("[redirect-resolve]", `${fullUrl} — failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function GET(req: NextRequest) {
  return runWithRequestId("GET", req, async () => {
  const session = await getValidSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  let fileId = parseGoogleDocId(url);

  // If the URL isn't a recognized Google Doc link, try following redirects
  // to see if it lands on one (e.g. go/my-doc → docs.google.com/document/d/...).
  if (!fileId) {
    const resolved = await tryResolveRedirect(url);
    if (resolved) {
      fileId = parseGoogleDocId(resolved);
    }
  }

  if (!fileId) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const existingRow = await prisma.doc.findUnique({
    where: { userId_googleDocId: { userId, googleDocId: fileId } },
    select: {
      docId: true, title: true, mimeType: true,
      notes: true, status: true, isStarred: true, accessState: true,
      labels: { select: { labelId: true } },
    },
  });
  const existing = existingRow?.accessState !== "OK" ? null : existingRow;

  let f;
  try {
    const driveAuth = await getDriveClient(userId);
    const drive = createDriveService(driveAuth);
    const res = await drive.files.get({
      fileId,
      fields: "name,mimeType,webViewLink,modifiedTime,createdTime,owners(me,displayName),trashed",
      supportsAllDrives: true,
    });
    f = res.data;
  } catch (err) {
    const reauth = invalidGrantResponse(err);
    if (reauth) return reauth;
    // Not found or permission denied — still allow adding
    return NextResponse.json({
      googleDocId: fileId,
      title: existing?.title ?? "Unknown title",
      mimeType: existing?.mimeType ?? "application/vnd.google-apps.document",
      driveUrl: `https://docs.google.com/document/d/${fileId}/edit`,
      permissionDenied: true,
      ...(existing ? {
        existing: true,
        docId: existing.docId,
        labels: existing.labels.map((l) => l.labelId),
        notes: existing.notes,
        status: existing.status,
        isStarred: existing.isStarred,
      } : {}),
    });
  }

  if (f.trashed) {
    return NextResponse.json({
      error: "trashed",
      title: f.name ?? "",
      mimeType: f.mimeType,
    }, { status: 400 });
  }

  if (!f.mimeType || !SUPPORTED_MIME_TYPES.has(f.mimeType)) {
    return NextResponse.json({
      error: "invalid_mime_type",
      title: f.name ?? "",
      mimeType: f.mimeType,
    }, { status: 400 });
  }

  const isOwner = f.owners?.some((o) => o.me === true) ?? false;

  return NextResponse.json({
    googleDocId: fileId,
    title: f.name ?? "",
    mimeType: f.mimeType,
    driveUrl: f.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
    role: isOwner ? "AUTHOR" : "REVIEWER",
    owner: f.owners?.[0]?.displayName ?? null,
    lastModifiedInDrive: f.modifiedTime ?? null,
    createdTimeInDrive: f.createdTime ?? null,
    ...(existing ? {
      existing: true,
      docId: existing.docId,
      labels: existing.labels.map((l) => l.labelId),
      notes: existing.notes,
      status: existing.status,
      isStarred: existing.isStarred,
    } : {}),
  });
  });
}

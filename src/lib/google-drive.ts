import { google } from "googleapis";
import { prisma } from "@/lib/prisma";

export async function getDriveClient(userId: string) {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "google" },
  });

  if (!account?.access_token) {
    throw new Error("No Google account found for user");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET
  );

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  // Persist refreshed tokens back to DB
  oauth2Client.on("tokens", async (tokens) => {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: tokens.access_token ?? account.access_token,
        refresh_token: tokens.refresh_token ?? account.refresh_token,
        expires_at: tokens.expiry_date
          ? Math.floor(tokens.expiry_date / 1000)
          : account.expires_at,
      },
    });
  });

  return oauth2Client;
}

export interface DriveDoc {
  googleDocId: string;
  title: string;
  driveUrl: string;
  role: "AUTHOR" | "REVIEWER";
  lastModifiedInDrive: Date | null;
}

// Returns the subset of googleDocIds that are deleted (trashed, permanently deleted, or access revoked).
// Runs all files.get calls in parallel rather than sequentially.
export async function findDeletedDocIds(
  userId: string,
  googleDocIds: string[]
): Promise<Set<string>> {
  if (googleDocIds.length === 0) return new Set();

  const auth = await getDriveClient(userId);
  const drive = google.drive({ version: "v3", auth });

  const results = await Promise.all(
    googleDocIds.map(async (id) => {
      try {
        console.log(`[Drive] files.get ${id}`);
        const res = await drive.files.get({ fileId: id, fields: "trashed" });
        const deleted = res.data.trashed === true;
        console.log(`[Drive] files.get ${id} → ${deleted ? "deleted/trashed" : "ok"}`);
        return { id, deleted };
      } catch {
        console.log(`[Drive] files.get ${id} → not found (deleted)`);
        return { id, deleted: true };
      }
    })
  );

  return new Set(results.filter((r) => r.deleted).map((r) => r.id));
}

export async function listRecentDocs(userId: string): Promise<DriveDoc[]> {
  const auth = await getDriveClient(userId);
  const drive = google.drive({ version: "v3", auth });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const modifiedAfter = thirtyDaysAgo.toISOString();

  const docs: DriveDoc[] = [];
  let pageToken: string | undefined;

  do {
    console.log(`[Drive] files.list (recent docs${pageToken ? ", page " + pageToken.slice(0, 8) + "…" : ""})`);
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${modifiedAfter}' and trashed = false`,
      fields:
        "nextPageToken, files(id, name, webViewLink, modifiedTime, owners)",
      pageSize: 100,
      pageToken,
    });
    console.log(`[Drive] files.list → ${res.data.files?.length ?? 0} files`);

    const files = res.data.files ?? [];
    for (const file of files) {
      if (!file.id || !file.name) continue;
      const isOwner = file.owners?.some((o) => o.me === true) ?? false;
      docs.push({
        googleDocId: file.id,
        title: file.name,
        driveUrl: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
        role: isOwner ? "AUTHOR" : "REVIEWER",
        lastModifiedInDrive: file.modifiedTime
          ? new Date(file.modifiedTime)
          : null,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return docs;
}

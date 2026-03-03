import { gmail as createGmail } from "@googleapis/gmail";
import { drive as createDrive } from "@googleapis/drive";
import { getDriveClient, parseGoogleDocId } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";

export interface GmailScanDoc {
  googleDocId: string;
  title: string;
  mimeType: string;
  driveUrl: string;
  owner: string | null;
  role: "AUTHOR" | "REVIEWER";
}

export interface GmailScanResult {
  docs: GmailScanDoc[];
  errorCount: number;
}

/** Scan Gmail for Google Doc notification emails and resolve doc metadata via Drive. */
export async function scanGmailNotifications(
  userId: string,
  since: Date
): Promise<GmailScanResult> {
  const auth = await getDriveClient(userId);
  const gmailClient = createGmail({ version: "v1", auth });
  const driveClient = createDrive({ version: "v3", auth });

  // Build date cutoff for Gmail query (day-level precision)
  const afterDate = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}`;
  const sinceMs = since.getTime();

  const query = `from:drive-shares-dm-noreply@google.com OR from:comments-noreply@docs.google.com after:${afterDate}`;
  logInfo(`[Gmail] Searching: ${query}`);

  // Collect all message IDs (paginated)
  const messageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const t0 = Date.now();
    const res = await gmailClient.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    logInfo(`[Gmail] messages.list → ${res.data.messages?.length ?? 0} messages (${Date.now() - t0}ms)`);

    for (const msg of res.data.messages ?? []) {
      if (msg.id) messageIds.push(msg.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (messageIds.length === 0) {
    logInfo("[Gmail] No notification emails found");
    return { docs: [], errorCount: 0 };
  }

  logInfo(`[Gmail] Total messages to process: ${messageIds.length}`);

  // Fetch each message and extract doc links
  let errorCount = 0;
  const docIdMap = new Map<string, { subject: string; messageId: string }>();

  await Promise.all(
    messageIds.map(async (messageId) => {
      const t0 = Date.now();
      try {
        const res = await gmailClient.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        });

        // Filter by internalDate for timestamp-level precision (Gmail after: is day-level only)
        const internalDate = Number(res.data.internalDate);
        if (internalDate && internalDate < sinceMs) {
          logInfo(`[Gmail] ${messageId}: skipped — internalDate ${new Date(internalDate).toISOString()} < since (${Date.now() - t0}ms)`);
          return;
        }

        const headers = res.data.payload?.headers ?? [];
        const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";

        // Extract doc URL from message body
        const body = extractBodyText(res.data.payload);
        const docId = body ? extractDocId(body) : null;

        if (docId) {
          logInfo(`[Gmail] ${messageId}: "${subject}" → doc ${docId} (${Date.now() - t0}ms)`);
          if (!docIdMap.has(docId)) {
            docIdMap.set(docId, { subject, messageId });
          }
        } else {
          logError(`[Gmail] ${messageId}: "${subject}" → no doc link found in body (${Date.now() - t0}ms)`);
          errorCount++;
        }
      } catch (err) {
        logError(`[Gmail] Failed to fetch message ${messageId} (${Date.now() - t0}ms):`, err);
        errorCount++;
      }
    })
  );

  if (docIdMap.size === 0) {
    logInfo(`[Gmail] No doc links found in any messages (${errorCount} errors)`);
    return { docs: [], errorCount };
  }

  logInfo(`[Gmail] Unique docs found: ${docIdMap.size}`);

  // Fetch Drive metadata for each doc
  const results: GmailScanDoc[] = [];

  await Promise.all(
    Array.from(docIdMap.entries()).map(async ([docId]) => {
      const t0 = Date.now();
      try {
        const res = await driveClient.files.get({
          fileId: docId,
          fields: "id, name, mimeType, webViewLink, owners(me, displayName)",
          supportsAllDrives: true,
        });

        const file = res.data;
        const isOwner = file.owners?.some((o) => o.me === true) ?? false;

        results.push({
          googleDocId: docId,
          title: file.name ?? docId,
          mimeType: file.mimeType ?? "",
          driveUrl: file.webViewLink ?? "",
          owner: file.owners?.[0]?.displayName ?? null,
          role: isOwner ? "AUTHOR" : "REVIEWER",
        });

        logInfo(`[Gmail] Drive metadata for ${docId}: "${file.name}" (${Date.now() - t0}ms)`);
      } catch (err: unknown) {
        const code = (err as { code?: number })?.code;
        if (code === 404) {
          logWarning(`[Gmail] Drive file not found: ${docId} (${Date.now() - t0}ms)`);
        } else {
          logError(`[Gmail] Drive metadata failed for ${docId} (${Date.now() - t0}ms):`, err);
        }
        errorCount++;
      }
    })
  );

  logInfo(`[Gmail] Scan complete: ${results.length} docs, ${errorCount} errors`);
  return { docs: results, errorCount };
}

/** Extract plaintext body from a Gmail message payload. */
function extractBodyText(
  payload: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: unknown[] | null } | null | undefined
): string | null {
  if (!payload) return null;

  // Simple single-part message
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // Multipart — search parts recursively
  if (payload.parts) {
    for (const part of payload.parts as Array<typeof payload>) {
      // Prefer text/plain
      if (part?.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      // Recurse into nested multipart
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
    // Fall back to text/html
    for (const part of payload.parts as Array<typeof payload>) {
      if (part?.mimeType === "text/html" && part?.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
  }

  return null;
}

/** Extract a Google Doc/Sheet/Slides ID from email body text. */
function extractDocId(body: string): string | null {
  // Match URLs like docs.google.com/document/d/DOC_ID or drive.google.com/open?id=DOC_ID
  const urlMatch = body.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) return parseGoogleDocId(`/d/${urlMatch[1]}/`);

  // Also try ?id= format
  const idMatch = body.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch) return idMatch[1];

  return null;
}

import { gmail as createGmail } from "@googleapis/gmail";
import { drive as createDrive } from "@googleapis/drive";
import { getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { formatDate } from "@/lib/utils";
import { extractBodyText, extractDocId, parseShareNote } from "@/lib/gmail-parse";

export interface GmailDocIdResult {
  docIds: string[];
  shareNotes: Map<string, string>;
  errorCount: number;
}

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
  shareNotes: Map<string, string>;
  errorCount: number;
  skipCount: number;
}

/** Scan Gmail for Google Doc notification emails and return just doc IDs (no Drive API calls). */
export async function scanGmailForDocIds(
  userId: string,
  since: Date
): Promise<GmailDocIdResult> {
  const auth = await getDriveClient(userId);
  const gmailClient = createGmail({ version: "v1", auth });

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
    return { docIds: [], shareNotes: new Map(), errorCount: 0 };
  }

  logInfo(`[Gmail] Total messages to process: ${messageIds.length}`);

  // Fetch each message and extract doc links
  let errorCount = 0;
  const docIdSet = new Set<string>();
  const shareNotes = new Map<string, string>();

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
          logInfo(`[Gmail] ${messageId}: skipped — internalDate ${formatDate(new Date(internalDate))} < since ${formatDate(since)} (${Date.now() - t0}ms)`);
          return;
        }

        const headers = res.data.payload?.headers ?? [];
        const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";

        // Extract doc URL from message body
        const body = extractBodyText(res.data.payload);
        const docId = body ? extractDocId(body) : null;

        if (docId) {
          logInfo(`[Gmail] ${messageId}: "${subject}" → doc ${docId} (${Date.now() - t0}ms)`);
          docIdSet.add(docId);

          // Extract share note from sharing emails (not comment notifications)
          const shareNote = body ? parseShareNote(headers, body) : null;
          if (shareNote) {
            shareNotes.set(docId, shareNote);
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

  const docIds = [...docIdSet];
  logInfo(`[Gmail] Scan complete: ${docIds.length} unique doc IDs, ${shareNotes.size} share notes, ${errorCount} errors`);
  return { docIds, shareNotes, errorCount };
}

/** Scan Gmail for Google Doc notification emails and resolve doc metadata via Drive. */
export async function scanGmailNotifications(
  userId: string,
  since: Date
): Promise<GmailScanResult> {
  const { docIds, shareNotes, errorCount: scanErrors } = await scanGmailForDocIds(userId, since);
  if (docIds.length === 0) return { docs: [], shareNotes, errorCount: scanErrors, skipCount: 0 };

  const auth = await getDriveClient(userId);
  const driveClient = createDrive({ version: "v3", auth });

  let errorCount = scanErrors;
  let skipCount = 0;
  const results: GmailScanDoc[] = [];

  await Promise.all(
    docIds.map(async (docId) => {
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
      } catch (err: any) {
        const code = err.code;
        if (code === 404) {
          logWarning(`[Gmail] Drive file not found: ${docId} (${Date.now() - t0}ms)`);
          skipCount++;
        } else if (code === 403) {
          logWarning(`[Gmail] Drive permission denied for ${docId} (${Date.now() - t0}ms)`);
          skipCount++;
        } else {
          logError(`[Gmail] Drive metadata failed for ${docId} (${Date.now() - t0}ms):`, err);
          errorCount++;
        }
      }
    })
  );

  logInfo(`[Gmail] Scan complete: ${results.length} docs, ${errorCount} errors, ${skipCount} skipped`);
  return { docs: results, shareNotes, errorCount, skipCount };
}

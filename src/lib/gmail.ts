import { gmail as createGmail } from "@googleapis/gmail";
import { drive as createDrive } from "@googleapis/drive";
import { getDriveClient } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { formatDate } from "@/lib/utils";
import { extractBodyText, extractHtmlBody, extractDocId, parseShareNote } from "@/lib/gmail-parse";
import { parseGmailNotificationFromParsed, type ParsedEmail } from "@/lib/parse-gmail-notification";
import type { OnProgress } from "./progress-events";

export interface GmailDocIdResult {
  docIds: string[];
  shareNotes: Map<string, string>;
  emailMeta: Map<string, ParsedEmail>;
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

export interface GmailInaccessibleDoc {
  googleDocId: string;
  title: string;
  accessState: "NOT_FOUND" | "DENIED";
  notes: string;
  emailDate: Date;
}

export interface GmailScanResult {
  docs: GmailScanDoc[];
  inaccessibleDocs: GmailInaccessibleDoc[];
  shareNotes: Map<string, string>;
  errorCount: number;
  skipCount: number;
}

/** Scan Gmail for Google Doc notification emails and return just doc IDs (no Drive API calls). */
export async function scanGmailForDocIds(
  userId: string,
  since: Date,
  onProgress?: (count: number, total?: number) => void
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
    return { docIds: [], shareNotes: new Map(), emailMeta: new Map(), errorCount: 0 };
  }

  const total = messageIds.length;
  logInfo(`[Gmail] Total messages to process: ${total}`);

  // Fetch each message and extract doc links
  let errorCount = 0;
  const docIdSet = new Set<string>();
  const shareNotes = new Map<string, string>();
  const emailMeta = new Map<string, ParsedEmail>();

  let processedCount = 0;
  onProgress?.(0, total);

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

          // Capture parsed email for use if Drive API fails
          if (!emailMeta.has(docId)) {
            const headerMap = new Map<string, string>();
            for (const h of headers) {
              if (h.name && h.value) headerMap.set(h.name.toLowerCase(), h.value);
            }
            emailMeta.set(docId, {
              headers: headerMap,
              textBody: body ?? "",
              htmlBody: extractHtmlBody(res.data.payload) ?? "",
            });
          }

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
      } finally {
        processedCount++;
        onProgress?.(processedCount, total);
      }
    })
  );

  const docIds = [...docIdSet];
  logInfo(`[Gmail] Scan complete: ${docIds.length} unique doc IDs, ${shareNotes.size} share notes, ${errorCount} errors`);
  return { docIds, shareNotes, emailMeta, errorCount };
}

/**
 * Build GmailInaccessibleDoc entries for doc IDs that failed Drive metadata fetch.
 * Uses email metadata captured during Gmail scanning for best-effort title/notes.
 * Parses email HTML via parse-gmail-notification.ts for structured comment/sharing info.
 */
export function buildInaccessibleDocs(
  failedDocIds: string[],
  emailMeta: Map<string, ParsedEmail>,
  accessState: "NOT_FOUND" | "DENIED" = "NOT_FOUND",
): GmailInaccessibleDoc[] {
  const results: GmailInaccessibleDoc[] = [];
  for (const docId of failedDocIds) {
    const email = emailMeta.get(docId);
    if (!email) continue;
    try {
      const stateLabel = accessState === "DENIED" ? "permission denied" : "not found";
      const dateRaw = email.headers.get("date") ?? "";
      const date = dateRaw ? new Date(dateRaw) : null;
      const dateStr = date && !isNaN(date.getTime()) ? formatDate(date, true) : dateRaw;

      let title = email.headers.get("subject") ?? "(no subject)";
      let notes = `Gmail notification received ${dateStr} (${stateLabel})`;

      // Use the full notification parser for structured data extraction
      if (email.htmlBody) {
        try {
          const parsed = parseGmailNotificationFromParsed(email);
          if (parsed.documentTitle) {
            title = parsed.documentTitle;
          }
          if (parsed.type === "comment" && parsed.comments.length > 0) {
            const reply = parsed.comments[0].replies[0];
            if (reply) {
              notes += `\n${reply.author}: ${reply.text}`;
            }
          } else if (parsed.type === "sharing" && parsed.sharerName) {
            notes += `\nShared by ${parsed.sharerName}`;
          }
        } catch {
          // Fall back to subject as title if parser fails
          logWarning(`[Gmail] Notification parser failed for ${docId}, using subject as title`);
        }
      }

      const emailDate = date && !isNaN(date.getTime()) ? date : new Date();
      results.push({ googleDocId: docId, title, accessState, notes, emailDate });
      logInfo(`[Gmail] Created inaccessible doc entry for ${docId}: "${title}" (${accessState})`);
    } catch (parseErr) {
      logWarning(`[Gmail] Failed to parse email metadata for inaccessible doc ${docId}:`, parseErr);
    }
  }
  return results;
}

/** Scan Gmail for Google Doc notification emails and resolve doc metadata via Drive. */
export async function scanGmailNotifications(
  userId: string,
  since: Date,
  onProgress?: OnProgress
): Promise<GmailScanResult> {
  const { docIds, shareNotes, emailMeta, errorCount: scanErrors } = await scanGmailForDocIds(userId, since, (count, total) => {
    onProgress?.({ phase: "gmail", status: "reading", count, total });
  });
  if (docIds.length === 0) {
    onProgress?.({ phase: "gmail", status: "done", count: 0, errorCount: scanErrors });
    return { docs: [], inaccessibleDocs: [], shareNotes, errorCount: scanErrors, skipCount: 0 };
  }
  onProgress?.({ phase: "gmail", status: "done", count: docIds.length, errorCount: scanErrors });

  const auth = await getDriveClient(userId);
  const driveClient = createDrive({ version: "v3", auth });

  let errorCount = scanErrors;
  let skipCount = 0;
  const results: GmailScanDoc[] = [];
  const failedDocs: Array<{ docId: string; accessState: "NOT_FOUND" | "DENIED" }> = [];

  let completedCount = 0;
  onProgress?.({ phase: "metadata", completed: 0, total: docIds.length });

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
        if (code === 404 || code === 403) {
          const accessState = code === 403 ? "DENIED" as const : "NOT_FOUND" as const;
          logWarning(`[Gmail] Drive ${accessState === "DENIED" ? "permission denied" : "file not found"}: ${docId} (${Date.now() - t0}ms)`);
          skipCount++;
          failedDocs.push({ docId, accessState });
        } else {
          logError(`[Gmail] Drive metadata failed for ${docId} (${Date.now() - t0}ms):`, err);
          errorCount++;
        }
      } finally {
        completedCount++;
        onProgress?.({ phase: "metadata", completed: completedCount, total: docIds.length });
      }
    })
  );

  // Build inaccessible doc entries from email metadata for failed Drive fetches
  // Group by accessState since buildInaccessibleDocs takes a single state
  const inaccessibleDocs: GmailInaccessibleDoc[] = [];
  for (const state of ["NOT_FOUND", "DENIED"] as const) {
    const ids = failedDocs.filter(f => f.accessState === state).map(f => f.docId);
    if (ids.length > 0) {
      inaccessibleDocs.push(...buildInaccessibleDocs(ids, emailMeta, state));
    }
  }

  logInfo(`[Gmail] Scan complete: ${results.length} docs, ${inaccessibleDocs.length} inaccessible, ${errorCount} errors, ${skipCount} skipped`);
  return { docs: results, inaccessibleDocs, shareNotes, errorCount, skipCount };
}

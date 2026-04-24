import { gmail as createGmail } from "@googleapis/gmail";
import { drive as createDrive } from "@googleapis/drive";
import { getDriveClient, driveUrlFor, isDriveErrorCode, parseGoogleDocId } from "@/lib/google-drive";
import { logError, logWarning, logInfo } from "@/lib/log";
import { formatDate, appendNotes } from "@/lib/utils";
import {
  parseGmailNotificationFromParsed,
  type ParsedEmail,
  type SharingNotification,
} from "@/lib/parse-gmail-notification";
import type { OnProgress } from "./progress-events";
import { AccessState, DocRole } from "@prisma/client";

/**
 * Gmail API `payload` shape (subset): multipart messages nest `parts`, each with
 * its own mimeType and either `body.data` (base64url-encoded) or nested parts.
 */
type GmailPayload = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[] | null;
};

/** Extract plaintext body from a Gmail API payload, recursing into multipart. */
function extractBodyText(payload: GmailPayload | null | undefined): string | null {
  if (!payload) return null;
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts as Array<GmailPayload>) {
      if (part?.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
    for (const part of payload.parts as Array<GmailPayload>) {
      if (part?.mimeType === "text/html" && part?.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
  }
  return null;
}

/** Extract HTML body from a Gmail API payload, recursing into multipart. */
function extractHtmlBody(payload: GmailPayload | null | undefined): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts as Array<GmailPayload>) {
      if (part?.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      const nested = extractHtmlBody(part);
      if (nested) return nested;
    }
  }
  return null;
}

/** Extract a Google Doc/Sheet/Slides ID from Gmail notification body text. */
function extractDocId(body: string): string | null {
  const urlMatch = body.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) return parseGoogleDocId(`/d/${urlMatch[1]}/`);
  const idMatch = body.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch) return idMatch[1];
  return null;
}

/**
 * Format a parsed SharingNotification into a human-readable note for storage in
 * the doc's `notes` field. Produces strings like:
 *   "Shared by Jane Doe (jane@example.com) on 2026-03-03 12:08"
 *   "Requested to share by Jane Doe on 2026-03-03 12:08\n<optional message>"
 * Falls back gracefully when sharer details or date are missing.
 */
export function formatShareNote(notification: SharingNotification): string {
  const verb = notification.isRequest ? "Requested to share by" : "Shared by";
  let note: string;
  if (notification.sharerName && notification.sharerEmail) {
    note = `${verb} ${notification.sharerName} (${notification.sharerEmail})`;
  } else if (notification.sharerEmail) {
    note = `${verb} ${notification.sharerEmail}`;
  } else if (notification.sharerName) {
    note = `${verb} ${notification.sharerName}`;
  } else {
    note = notification.isRequest ? "Requested to share" : "Shared";
  }

  const date = notification.date ? new Date(notification.date) : null;
  if (date && !isNaN(date.getTime())) {
    note += ` on ${formatDate(date, true)}`;
  }

  if (notification.shareMessage) {
    note += "\n" + notification.shareMessage;
  }
  return note;
}

/** AccessState values that mean "tracked but inaccessible". */
type InaccessibleState = typeof AccessState.NOT_FOUND | typeof AccessState.DENIED;

export interface GmailDocIdResult {
  docIds: string[];
  shareNotes: Map<string, string>;
  emailMeta: Map<string, ParsedEmail[]>;
  errorCount: number;
  /** True when the Google account has no Gmail mailbox (Gmail returned failedPrecondition). */
  noGmailAccount?: boolean;
}

/**
 * Detect the Gmail API error returned when a Google account has no Gmail mailbox
 * (e.g., a Google account that was never provisioned with Gmail, or a Workspace
 * user with the Gmail service disabled). Gmail returns HTTP 400 with structured
 * reason "failedPrecondition" — typical underlying message is "Mail service not
 * enabled". The googleapis library stringifies this as "Precondition check failed."
 *
 * Detection priority: structured `errors[].reason === "failedPrecondition"` first
 * (per Google API error format), with a message-text fallback for safety.
 */
export function isNoGmailMailboxError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // Intentionally does not use isDriveErrorCode: the Gmail "no mailbox" signal
  // is specifically the pairing of code 400 with a structural
  // `errors[].reason === "failedPrecondition"` reason — falling back to
  // `err.status` would over-match unrelated 400s from other Gmail errors.
  const code = (err as { code?: number | string }).code;
  if (code !== 400 && code !== "400") return false;

  const errors = (err as { errors?: Array<{ reason?: string }> }).errors;
  if (Array.isArray(errors) && errors.some((e) => e?.reason === "failedPrecondition")) {
    return true;
  }
  const message = (err as { message?: string }).message ?? "";
  return /precondition check failed|mail service not enabled/i.test(message);
}

/**
 * Pull the most informative message and reason out of a googleapis error so we can
 * log something more specific than "Precondition check failed." Looks at structured
 * `errors[]`, then `response.data.error`, then the bare `message` field.
 */
export function describeGoogleApiError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as {
    message?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
    response?: { data?: { error?: { message?: string; status?: string; errors?: Array<{ reason?: string; message?: string }> } } };
  };
  const parts: string[] = [];
  const structured = e.errors?.[0] ?? e.response?.data?.error?.errors?.[0];
  if (structured?.reason) parts.push(`reason=${structured.reason}`);
  const detailMessage = structured?.message ?? e.response?.data?.error?.message ?? e.message;
  if (detailMessage) parts.push(`message="${detailMessage}"`);
  const status = e.response?.data?.error?.status;
  if (status) parts.push(`status=${status}`);
  return parts.length > 0 ? parts.join(" ") : String(err);
}

export interface GmailScanDoc {
  googleDocId: string;
  title: string;
  mimeType: string;
  driveUrl: string;
  role: DocRole;
}

export interface GmailInaccessibleDoc {
  googleDocId: string;
  title: string;
  accessState: InaccessibleState;
  notes: string;
  emailDate: Date;
}

export interface GmailScanResult {
  docs: GmailScanDoc[];
  inaccessibleDocs: GmailInaccessibleDoc[];
  shareNotes: Map<string, string>;
  errorCount: number;
  skipCount: number;
  /** True when the Google account has no Gmail mailbox (Gmail returned failedPrecondition). */
  noGmailAccount?: boolean;
}

/**
 * Scan Gmail for Google Doc notification emails and return doc IDs, share notes, and
 * raw email metadata (no Drive API calls). This is the low-level scanner used by both
 * Refresh (refresh.ts) and the Load dialog (via scanGmailNotifications). Share notes
 * are generated here via parseShareNote() for docs whose Drive metadata fetch succeeds.
 */
export async function scanGmailForDocIds(
  userId: string,
  since: Date,
  userEmail?: string,
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

  try {
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
  } catch (err) {
    // Google account without a Gmail mailbox — skip Gmail scanning gracefully.
    if (isNoGmailMailboxError(err)) {
      logWarning(`[Gmail] Skipping scan — Gmail not available for this account (${describeGoogleApiError(err)})`);
      return {
        docIds: [],
        shareNotes: new Map(),
        emailMeta: new Map<string, ParsedEmail[]>(),
        errorCount: 0,
        noGmailAccount: true,
      };
    }
    throw err;
  }

  if (messageIds.length === 0) {
    logInfo("[Gmail] No notification emails found");
    return { docIds: [], shareNotes: new Map(), emailMeta: new Map<string, ParsedEmail[]>(), errorCount: 0 };
  }

  const total = messageIds.length;
  logInfo(`[Gmail] Total messages to process: ${total}`);

  // Fetch each message and extract doc links
  let errorCount = 0;
  const docIdSet = new Set<string>();
  const shareNotes = new Map<string, string>();
  const emailMeta = new Map<string, ParsedEmail[]>();

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
        const fromHeader = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";

        // Skip sharing notifications that are confirmations of our own shares
        // (reply-to contains our email, matching the logged-in user)
        if (fromHeader.includes("drive-shares-dm-noreply@google.com")) {
          const replyToHeader = headers.find((h) => h.name?.toLowerCase() === "reply-to")?.value ?? "";
          const replyToEmail = replyToHeader.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? replyToHeader.trim().toLowerCase();
          if (replyToEmail && userEmail && replyToEmail === userEmail.toLowerCase()) {
            logInfo(`[Gmail] ${messageId}: skipped — sharing notification from self (reply-to: ${replyToEmail}) (${Date.now() - t0}ms)`);
            return;
          }
        }

        // Extract doc URL from message body
        const body = extractBodyText(res.data.payload);
        const htmlBody = extractHtmlBody(res.data.payload);
        const headerMap = new Map<string, string>();
        for (const h of headers) {
          if (h.name && h.value) headerMap.set(h.name.toLowerCase(), h.value);
        }
        const parsed: ParsedEmail = {
          headers: headerMap,
          textBody: body ?? "",
          htmlBody: htmlBody ?? "",
        };

        try {
          const notif = parseGmailNotificationFromParsed(parsed);
          const docId = notif.documentId;

          if (docId) {
            logInfo(`[Gmail] ${messageId} → doc ${docId} (${Date.now() - t0}ms)`);
            docIdSet.add(docId);

            // Capture parsed email for inaccessible doc fallback and suggestion merging
            const existing = emailMeta.get(docId);
            if (existing) {
              existing.push(parsed);
            } else {
              emailMeta.set(docId, [parsed]);
            }

            // Handle specific notification types for notes
            let note = "";
            if (notif.type === "sharing") {
              note = formatShareNote(notif);
            }
            
            if (note) {
              const existingNote = shareNotes.get(docId);
              shareNotes.set(docId, existingNote ? appendNotes(existingNote, note) : note);
            }
          } else {
            logError(`[Gmail] ${messageId}: no doc link found in parsed notification. (${Date.now() - t0}ms)`);
            errorCount++;
          }
        } catch (parseErr) {
          logError(`[Gmail] ${messageId}: failed to parse notification (${Date.now() - t0}ms):`, parseErr);
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
 * Build GmailInaccessibleDoc entries for doc IDs that failed Drive metadata fetch (404/403).
 * Uses email metadata captured during Gmail scanning for best-effort title and notes.
 * Called by both Refresh (refresh.ts) and the Load dialog (scanGmailNotifications) when
 * a Gmail notification references a doc the user can't access (e.g., @-mention in an
 * unshared doc, or a share request for a doc with restricted access).
 */
export function buildInaccessibleDocs(
  failedDocIds: string[],
  emailMeta: Map<string, ParsedEmail[]>,
  accessState: InaccessibleState = AccessState.NOT_FOUND,
): GmailInaccessibleDoc[] {
  const results: GmailInaccessibleDoc[] = [];
  for (const docId of failedDocIds) {
    const emails = emailMeta.get(docId);
    if (!emails || emails.length === 0) continue;
    try {
      const stateLabel = accessState === AccessState.DENIED ? "permission denied" : "not found";
      
      let title = "(no subject)";
      let notes = `Gmail notifications received (${stateLabel}):`;
      let emailDate = new Date();
      let dateSet = false;

      for (const email of emails) {
        const dateRaw = email.headers.get("date") ?? "";
        const date = dateRaw ? new Date(dateRaw) : null;
        const dateStr = date && !isNaN(date.getTime()) ? formatDate(date, true) : dateRaw;

        if (!dateSet && date && !isNaN(date.getTime())) {
          emailDate = date;
          dateSet = true;
        }

        if (title === "(no subject)") {
          title = email.headers.get("subject") ?? "(no subject)";
        }

        if (email.htmlBody) {
          try {
            const parsed = parseGmailNotificationFromParsed(email);
            if (parsed.documentTitle && title === "(no subject)") {
              title = parsed.documentTitle;
            }

            let newNote = "";
            if (parsed.type === "comment" && parsed.comments.length > 0) {
              const reply = parsed.comments[0].replies[0];
              if (reply) {
                newNote = `[${dateStr}] ${reply.author}: ${reply.text}`;
              }
            } else if (parsed.type === "sharing") {
              newNote = formatShareNote(parsed);
            }

            if (newNote) {
              notes = appendNotes(notes, newNote);
            }
          } catch {
            logWarning(`[Gmail] Notification parser failed for ${docId}, using subject as title`);
          }
        }
      }

      results.push({ googleDocId: docId, title, accessState, notes, emailDate });
      logInfo(`[Gmail] Created inaccessible doc entry for ${docId} (${accessState})`);
    } catch (parseErr) {
      logWarning(`[Gmail] Failed to parse email metadata for inaccessible doc ${docId}:`, parseErr);
    }
  }
  return results;
}

/**
 * All-in-one Gmail scanner: calls scanGmailForDocIds, fetches Drive metadata, and builds
 * inaccessible doc entries for failed fetches. Only used by the Load dialog (scan/route.ts).
 * Refresh does these steps separately for more control over the flow.
 */
export async function scanGmailNotifications(
  userId: string,
  since: Date,
  userEmail?: string,
  onProgress?: OnProgress
): Promise<GmailScanResult> {
  const { docIds, shareNotes, emailMeta, errorCount: scanErrors, noGmailAccount } = await scanGmailForDocIds(userId, since, userEmail, (count, total) => {
    onProgress?.({ phase: "gmail", status: "reading", count, total });
  });
  if (docIds.length === 0) {
    onProgress?.({ phase: "gmail", status: "done", count: 0, errorCount: scanErrors, noGmailAccount });
    return { docs: [], inaccessibleDocs: [], shareNotes, errorCount: scanErrors, skipCount: 0, noGmailAccount };
  }
  // Defense in depth: noGmailAccount implies docIds.length === 0 today (early
  // return above), so this branch is unreachable when the flag is set. Forward
  // it anyway so a future change to the early-return guard can't silently drop it.
  onProgress?.({ phase: "gmail", status: "done", count: docIds.length, errorCount: scanErrors, noGmailAccount });

  const auth = await getDriveClient(userId);
  const driveClient = createDrive({ version: "v3", auth });

  let errorCount = scanErrors;
  let skipCount = 0;
  const results: GmailScanDoc[] = [];
  const failedDocs: Array<{ docId: string; accessState: InaccessibleState }> = [];

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
          driveUrl: driveUrlFor(docId, file.webViewLink),
          role: isOwner ? DocRole.AUTHOR : DocRole.REVIEWER,
        });

        logInfo(`[Gmail] Drive metadata for ${docId} (${Date.now() - t0}ms)`);
      } catch (err) {
        const denied = isDriveErrorCode(err, 403);
        const notFound = isDriveErrorCode(err, 404);
        if (denied || notFound) {
          const accessState: InaccessibleState = denied ? AccessState.DENIED : AccessState.NOT_FOUND;
          logWarning(`[Gmail] Drive ${denied ? "permission denied" : "file not found"}: ${docId} (${Date.now() - t0}ms)`);
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
  for (const state of [AccessState.NOT_FOUND, AccessState.DENIED] as const) {
    const ids = failedDocs.filter(f => f.accessState === state).map(f => f.docId);
    if (ids.length > 0) {
      inaccessibleDocs.push(...buildInaccessibleDocs(ids, emailMeta, state));
    }
  }

  logInfo(`[Gmail] Scan complete: ${results.length} docs, ${inaccessibleDocs.length} inaccessible, ${errorCount} errors, ${skipCount} skipped`);
  return { docs: results, inaccessibleDocs, shareNotes, errorCount, skipCount, noGmailAccount };
}

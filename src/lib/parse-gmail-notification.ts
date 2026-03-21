/**
 * Parses Google Docs/Drive notification emails into structured JSON.
 *
 * Supports two email types:
 * - Comment notifications (from comments-noreply@docs.google.com)
 * - Sharing invitations (from drive-shares-dm-noreply@google.com)
 *
 * Input: raw .eml file content (string).
 * Output: a typed notification object with all extractable data.
 *
 * Tests: src/lib/parse-gmail-notification.test.ts
 * Examples: testing/gmail_notifications/
 * Scripts: scripts/check-gmail-notifications.ts, scripts/parse-gmail-notification.ts
 * Skill: /gmail-notification-parser (check, fix, add)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommentReply {
  author: string;
  time_str: string;      // original formatted string from email, e.g. "6:34 PM, Mar 7 (UTC)"
  time?: string;          // ISO 8601 if we could parse time_str; undefined otherwise
  text: string;
  isNew: boolean;
  avatarUrl?: string;
}

export interface CommentThread {
  quotedText?: string;
  assignedTo?: string;
  discussionId: string;
  openUrl: string;
  replyTo: string;
  replies: CommentReply[];
}

export interface Suggestion {
  author: string;
  time_str: string;      // original formatted string from email
  time?: string;          // ISO 8601 if parseable
  action: string; // "Delete", "Add", "Replace"
  text: string;
  oldText?: string; // for Replace
  newText?: string; // for Replace
  isNew: boolean;
  discussionId: string;
  openUrl: string;
  replyTo: string;
  replies: CommentReply[];
}

export interface CommentNotification {
  type: "comment";
  subject: string;
  from: string;
  to: string;
  date_str: string;       // original Date header, e.g. "Sat, 07 Mar 2026 10:42:27 -0800"
  date?: string;           // ISO 8601 if parseable
  documentId: string;
  documentTitle: string;
  documentUrl: string;
  xDocumentId?: string;
  feedbackId?: string;
  recipientUserId?: string;
  comments: CommentThread[];
  suggestions: Suggestion[];
}

export interface SharingNotification {
  type: "sharing";
  subject: string;
  from: string;
  to: string;
  date_str: string;       // original Date header
  date?: string;           // ISO 8601 if parseable
  sharerName: string;
  sharerEmail: string;
  permission: string; // "edit", "view", "comment", "writer"
  isRequest: boolean; // true if this is a request for access, not an invitation
  documentTitle: string;
  documentUrl: string;
  documentId: string;
}

export type GmailNotification = CommentNotification | SharingNotification;

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export interface ParsedEmail {
  headers: Map<string, string>;
  textBody: string;
  htmlBody: string;
}

function parseEmail(raw: string): ParsedEmail {
  // Split headers from body at first blank line (handle both \r\n and \n)
  const blankLineMatch = raw.match(/\r?\n\r?\n/);
  if (!blankLineMatch) {
    throw new Error("Invalid email: no blank line separating headers from body");
  }
  const headerSection = raw.substring(0, blankLineMatch.index!);
  const bodySection = raw.substring(blankLineMatch.index! + blankLineMatch[0].length);

  // Parse headers (unfold continuation lines)
  const headers = new Map<string, string>();
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const value = line.substring(colonIdx + 1).trim();
      headers.set(key, value);
    }
  }

  // Find MIME boundary
  const contentType = headers.get("content-type") || "";
  const boundaryMatch = contentType.match(/boundary="([^"]+)"/);
  const boundary = boundaryMatch ? boundaryMatch[1] : null;

  let textBody = "";
  let htmlBody = "";

  if (boundary) {
    const parts = bodySection.split(`--${boundary}`);
    for (const part of parts) {
      const partBlank = part.match(/\r?\n\r?\n/);
      if (!partBlank) continue;
      const partHeaders = part.substring(0, partBlank.index!).toLowerCase();
      const partBody = part.substring(partBlank.index! + partBlank[0].length);

      if (partHeaders.includes("text/plain")) {
        const encoding = partHeaders.includes("base64") ? "base64" :
                         partHeaders.includes("quoted-printable") ? "qp" : "none";
        textBody = decodeContent(partBody, encoding);
      } else if (partHeaders.includes("text/html")) {
        const encoding = partHeaders.includes("base64") ? "base64" :
                         partHeaders.includes("quoted-printable") ? "qp" : "none";
        htmlBody = decodeContent(partBody, encoding);
      }
    }
  }

  return { headers, textBody, htmlBody };
}

function decodeContent(content: string, encoding: string): string {
  if (encoding === "base64") {
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf-8");
  }
  if (encoding === "qp") {
    // Decode quoted-printable to bytes, then interpret as UTF-8
    const decoded = content
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    // Re-encode latin1 string as UTF-8
    return Buffer.from(decoded, "latin1").toString("utf-8");
  }
  return content;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers (no DOM dependency — regex-based for server use)
// ---------------------------------------------------------------------------

function extractDocIdFromUrl(url: string): string {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : "";
}

function extractDiscoId(url: string): string {
  const match = url.match(/disco=([^&]+)/);
  return match ? match[1] : "";
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\u00e2\u0080\u00a2/g, "•") // UTF-8 bullet mangled as latin1
    .replace(/\u00e2\u0080\u009c/g, "\u201c") // left smart quote
    .replace(/\u00e2\u0080\u009d/g, "\u201d") // right smart quote
    .replace(/\u00e2\u0080\u00af/g, "\u202f"); // narrow no-break space
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")           // <br> → space
    .replace(/<\/(?:div|p|td|tr|li)>/gi, " ") // closing block tags → space
    .replace(/<[^>]+>/g, "")                 // strip remaining tags
    .replace(/\u00a0/g, " ")                 // nbsp → space
    .replace(/ {2,}/g, " ")                  // collapse multiple spaces
    .trim();
}

// ---------------------------------------------------------------------------
// Time parsing helpers
// ---------------------------------------------------------------------------

const MONTH_MAP: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse a Google-formatted comment time string like "6:34 PM, Mar 7 (UTC)"
 * into an ISO 8601 timestamp. The year is inferred from the email's Date header.
 *
 * NOTE: This format is what Google uses for English-locale emails. Other locales
 * will likely produce different formats (24-hour time, localized month names,
 * different ordering) that won't match this regex — in which case we return
 * undefined and the caller falls back to time_str only.
 *
 * The seconds are always :00 because Google only shows minute-level precision
 * in the email.
 */
export function parseCommentTime(timeStr: string, emailDateStr: string): string | undefined {
  // English-locale format: "H:MM AM/PM, Mon DD (TZ)"
  // The \s in the regex also matches \u202f (narrow no-break space) that Google
  // uses between the time and AM/PM in the email HTML.
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM),\s*(\w{3})\s+(\d{1,2})\s*\(([^)]+)\)$/);
  if (!m) return undefined;

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3];
  const monthAbbr = m[4];
  const day = parseInt(m[5], 10);
  const tz = m[6];

  // We can only reliably convert UTC times — if Google shows a different
  // timezone, we'd need an offset table to convert correctly.
  if (tz !== "UTC") return undefined;

  // Convert 12-hour to 24-hour
  if (ampm === "AM" && hours === 12) hours = 0;
  else if (ampm === "PM" && hours !== 12) hours += 12;

  const month = MONTH_MAP[monthAbbr];
  if (month === undefined) return undefined;

  // Get year from email Date header
  const emailDate = new Date(emailDateStr);
  if (isNaN(emailDate.getTime())) return undefined;
  const year = emailDate.getUTCFullYear();

  // Build the date in UTC (Google shows comment times in UTC)
  const dt = new Date(Date.UTC(year, month, day, hours, minutes, 0));
  if (isNaN(dt.getTime())) return undefined;

  return dt.toISOString();
}

/** Convert an RFC 2822 date string to ISO 8601, or undefined on failure. */
export function headerDateToISO(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Comment notification parser
// ---------------------------------------------------------------------------

function parseCommentNotification(email: ParsedEmail): CommentNotification {
  const html = email.htmlBody;
  const headers = email.headers;

  // Document info from schema.org meta tags
  const titleMatch = html.match(/itemprop="name"\s+content="([^"]+)"/);
  const urlMatch = html.match(/itemprop="url"\s+content="([^"]+)"/);
  const documentTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : "";
  const documentUrl = urlMatch ? decodeHtmlEntities(urlMatch[1]) : "";
  const documentId = extractDocIdFromUrl(documentUrl);

  // Recipient user ID from the "Change what Google sends you" link
  const ouidMatch = html.match(/ouid=(\d+)/);
  const recipientUserId = ouidMatch ? ouidMatch[1] : undefined;

  const dateStr = headers.get("date") || "";
  const dateISO = headerDateToISO(dateStr);

  // Parse comment sections — each is in a card with "N comment(s)" heading
  const comments: CommentThread[] = [];
  const suggestions: Suggestion[] = [];

  // Split into discussion sections by ViewAction meta tags
  const viewActionPattern = /itemprop="action"[^>]*itemtype="http:\/\/schema\.org\/ViewAction">\s*<meta\s+itemprop="url"\s+content="([^"]+)"/g;
  const viewActions: { url: string; index: number }[] = [];
  let actionMatch;
  while ((actionMatch = viewActionPattern.exec(html)) !== null) {
    viewActions.push({ url: decodeHtmlEntities(actionMatch[1]), index: actionMatch.index });
  }

  for (let i = 0; i < viewActions.length; i++) {
    const action = viewActions[i];
    const nextIndex = i + 1 < viewActions.length ? viewActions[i + 1].index : html.length;
    const section = html.substring(action.index, nextIndex);
    const discoId = extractDiscoId(action.url);
    const isComment = action.url.includes("comment_email_discussion") || action.url.includes("todo_email_discussion");
    const isSuggestion = action.url.includes("suggestion_email_discussion");

    // Find reply-to mailto
    const mailtoMatch = section.match(/href="mailTo:([^"]+)"/);
    const replyTo = mailtoMatch
      ? decodeURIComponent(mailtoMatch[1]).replace(/^Reply\s+</, "").replace(/>\?.*$/, "")
      : "";

    // Find Open link
    const openMatch = section.match(/href="(https:\/\/docs\.google\.com\/[^"]*disco=[^"]+)"[^>]*>Open</);
    const openUrl = openMatch ? decodeHtmlEntities(openMatch[1]) : action.url;

    // Parse posts (author + text blocks)
    const posts = parsePostsInSection(section, dateStr);

    if (isComment) {
      // Quoted text is in the .document-content-snippet
      const snippetMatch = section.match(/class="document-content-snippet"[^>]*>.*?class="notranslate"[^>]*>(.*?)<\/span>/s);
      const quotedText = snippetMatch ? stripTags(decodeHtmlEntities(snippetMatch[1])) : undefined;

      // Check for "Assigned to you" label
      const assignedMatch = section.match(/<i>Assigned to you<\/i>/);
      const assignedTo = assignedMatch ? "you" : undefined;

      comments.push({
        quotedText,
        ...(assignedTo ? { assignedTo } : {}),
        discussionId: discoId,
        openUrl,
        replyTo,
        replies: posts,
      });
    } else if (isSuggestion) {
      // Suggestion action text
      const suggestionDiv = section.match(/font-weight:bold">(.*?)<\/span>\s*<span[^>]*>(.*?)<\/span>(?:\s*with\s*<span[^>]*>(.*?)<\/span>)?/s);
      let suggestionAction = "";
      let text = "";
      let oldText: string | undefined;
      let newText: string | undefined;

      if (suggestionDiv) {
        suggestionAction = stripTags(suggestionDiv[1]).replace(/:$/, "");
        text = stripTags(decodeHtmlEntities(suggestionDiv[2])).replace(/^"|"$/g, "");
        if (suggestionDiv[3]) {
          // Replace: "old" with "new"
          oldText = text;
          newText = stripTags(decodeHtmlEntities(suggestionDiv[3])).replace(/^"|"$/g, "");
          text = `${oldText} → ${newText}`;
        }
      }

      const post = posts[0];
      // Posts after the first are replies to the suggestion
      const replies = posts.slice(1);
      suggestions.push({
        author: post?.author || "",
        time_str: post?.time_str || "",
        ...(post?.time ? { time: post.time } : {}),
        action: suggestionAction,
        text,
        oldText,
        newText,
        isNew: post?.isNew || false,
        discussionId: discoId,
        openUrl,
        replyTo,
        replies,
      });
    }
  }

  return {
    type: "comment",
    subject: headers.get("subject") || "",
    from: headers.get("from") || "",
    to: headers.get("to") || "",
    date_str: dateStr,
    ...(dateISO ? { date: dateISO } : {}),
    documentId,
    documentTitle,
    documentUrl,
    xDocumentId: headers.get("x-document-id") || undefined,
    feedbackId: headers.get("feedback-id") || undefined,
    recipientUserId,
    comments,
    suggestions,
  };
}

function parsePostsInSection(section: string, emailDateStr: string): CommentReply[] {
  const posts: CommentReply[] = [];

  // Find all <h3> author headings followed by timestamp and text
  const authorPattern = /<h3[^>]*>([^<]+)<\/h3>\s*<span[^>]*>(.*?)<\/span>(.*?)(?=<\/td>|<\/tr>)/gs;
  let match;
  while ((match = authorPattern.exec(section)) !== null) {
    const author = stripTags(match[1]).trim();
    const timeRaw = stripTags(match[2]).trim();
    const time_str = timeRaw.replace(/^[•\s]+/, "").trim();
    const time = parseCommentTime(time_str, emailDateStr);
    const rest = match[3];

    const isNew = rest.includes(">New<");

    // Extract the comment text from .notranslate div
    const textMatch = rest.match(/class="notranslate"[^>]*>(.*?)<\/div>/s);
    const text = textMatch ? stripTags(decodeHtmlEntities(textMatch[1])).trim() : "";

    // Avatar URL
    const avatarMatch = section.substring(Math.max(0, match.index - 500), match.index + match[0].length)
      .match(/src="(https:\/\/lh3\.googleusercontent\.com\/[^"]+)"/);
    const avatarUrl = avatarMatch ? avatarMatch[1] : undefined;

    if (author && (text || rest.includes("font-weight:bold"))) {
      posts.push({ author, time_str, ...(time ? { time } : {}), text, isNew, avatarUrl });
    }
  }

  return posts;
}

// ---------------------------------------------------------------------------
// Sharing invitation parser
// ---------------------------------------------------------------------------

function parseSharingNotification(email: ParsedEmail): SharingNotification {
  const html = email.htmlBody;
  const headers = email.headers;

  // "Jeff Shute (jshute@gmail.com) has invited you to edit" — sharing invitation
  const inviteMatch = html.match(/>([\w\s]+)\s*\(<a[^>]*mailto:([^"]+)"[^>]*>[^<]+<\/a>\)\s*has invited you to\s*<b>(\w+)<\/b>/);
  // "Jeff Shute (jshute@gmail.com) is requesting access" — share request
  const requestMatch = !inviteMatch ? html.match(/>([\w\s]+)\s*\(<a[^>]*mailto:([^"]+)"[^>]*>[^<]+<\/a>\)\s*is\s*<b>requesting access<\/b>/) : null;
  const sharerMatch = inviteMatch || requestMatch;
  const sharerName = sharerMatch ? sharerMatch[1].trim() : "";
  const sharerEmail = sharerMatch ? sharerMatch[2] : (headers.get("reply-to")?.match(/<([^>]+)>/)?.[1] || "");
  // For invitations, permission is in the text ("edit", "view", "comment")
  // For share requests, extract from URL role parameter
  let permission = inviteMatch ? inviteMatch[3] : "";
  if (requestMatch && !permission) {
    const roleMatch = html.match(/role=(\w+)/);
    permission = roleMatch ? roleMatch[1] : "";
  }

  // Document title from chip
  const titleMatch = html.match(/vertical-align: middle;">([^<]+)<\/span><\/div><\/a>/);
  const documentTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : "";

  // Document URL
  const urlMatch = html.match(/href="(https:\/\/docs\.google\.com\/[^"]*\/d\/[^"]+)"[^>]*target="_blank"[^>]*style="[^"]*text-decoration: none/);
  const documentUrl = urlMatch ? decodeHtmlEntities(urlMatch[1]) : "";
  const documentId = extractDocIdFromUrl(documentUrl);

  const sharingDateStr = headers.get("date") || "";
  const sharingDateISO = headerDateToISO(sharingDateStr);

  return {
    type: "sharing",
    subject: headers.get("subject") || "",
    from: headers.get("from") || "",
    to: headers.get("to") || "",
    date_str: sharingDateStr,
    ...(sharingDateISO ? { date: sharingDateISO } : {}),
    sharerName,
    sharerEmail,
    permission,
    isRequest: !!requestMatch,
    documentTitle,
    documentUrl,
    documentId,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseGmailNotification(raw: string): GmailNotification {
  return parseGmailNotificationFromParsed(parseEmail(raw));
}

/** Parse from an already-parsed email (headers + bodies). Useful when data comes from the Gmail API. */
export function parseGmailNotificationFromParsed(email: ParsedEmail): GmailNotification {
  const from = email.headers.get("from") || "";

  if (from.includes("comments-noreply@docs.google.com")) {
    return parseCommentNotification(email);
  }
  if (from.includes("drive-shares-dm-noreply@google.com") || from.includes("via Google Docs")) {
    return parseSharingNotification(email);
  }

  throw new Error(`Unrecognized notification type from: ${from}`);
}

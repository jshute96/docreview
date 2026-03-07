import { parseGoogleDocId } from "@/lib/google-drive";
import { formatDate } from "@/lib/utils";

/** Parse a share notification email and return a formatted note, or null if not a share email. */
export function parseShareNote(
  headers: Array<{ name?: string | null; value?: string | null }>,
  body: string,
): string | null {
  // Only share emails come from this address; comment emails use comments-noreply@
  const from = headers.find(h => h.name?.toLowerCase() === "from")?.value ?? "";
  if (!from.includes("drive-shares-dm-noreply@google.com")) return null;

  // Extract sharer from Reply-To: "Someone <who@where.com>"
  const replyTo = headers.find(h => h.name?.toLowerCase() === "reply-to")?.value ?? "";
  const replyToMatch = replyTo.match(/^(.+?)\s*<([^>]+)>$/);
  const sharerName = replyToMatch?.[1]?.trim() ?? null;
  const sharerEmail = replyToMatch?.[2] ?? null;

  // Extract date
  const dateStr = headers.find(h => h.name?.toLowerCase() === "date")?.value;
  const date = dateStr ? new Date(dateStr) : null;
  const dateFormatted = date && !isNaN(date.getTime()) ? formatDate(date, true) : null;

  // Build sharer attribution
  let note: string;
  if (sharerName && sharerEmail) {
    note = `Shared by ${sharerName} (${sharerEmail})`;
  } else if (sharerEmail) {
    note = `Shared by ${sharerEmail}`;
  } else {
    note = "Shared";
  }
  if (dateFormatted) {
    note += ` on ${dateFormatted}`;
  }

  // Extract optional share message from plaintext body
  const message = extractShareMessage(body);
  if (message) {
    note += "\n" + message;
  }

  return note;
}

/** Extract the optional share message from a sharing email's plaintext body. */
export function extractShareMessage(body: string): string | null {
  // Plaintext structure (language-independent):
  //   paragraph 0: intro line
  //   paragraph 1: title + URL
  //   paragraph 2: boilerplate (varies by locale)
  //   paragraph 3+: share message (optional)
  const paragraphs = body.split(/\n\s*\n/);

  // Find the paragraph containing the doc URL (language-independent anchor)
  const urlParaIndex = paragraphs.findIndex(p =>
    /https:\/\/(docs|sheets|slides|drive)\.google\.com\//.test(p)
  );
  if (urlParaIndex < 0) return null;

  // Skip boilerplate paragraph (urlParaIndex + 1), take everything after
  if (urlParaIndex + 2 >= paragraphs.length) return null;

  const message = paragraphs.slice(urlParaIndex + 2).join("\n\n").trim();
  return message || null;
}

/** Extract plaintext body from a Gmail message payload. */
export function extractBodyText(
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
export function extractDocId(body: string): string | null {
  // Match URLs like docs.google.com/document/d/DOC_ID or drive.google.com/open?id=DOC_ID
  const urlMatch = body.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) return parseGoogleDocId(`/d/${urlMatch[1]}/`);

  // Also try ?id= format
  const idMatch = body.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch) return idMatch[1];

  return null;
}

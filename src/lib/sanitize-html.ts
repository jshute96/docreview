import DOMPurify from "dompurify";

/**
 * Sanitize an HTML fragment before rendering it via `dangerouslySetInnerHTML`.
 *
 * Comment/reply `htmlContent` and `quotedFileContent` come from the Google Drive
 * API, which escapes user text when building the HTML — so this is defense in
 * depth, not the primary protection. It guards against the trust boundary being
 * broken (a compromised or changed Drive response) by stripping scripts, event
 * handlers, and dangerous URLs while preserving the basic inline formatting
 * (`<b>`, `<i>`, `<a>`, `<br>`, etc.) Drive emits.
 *
 * DOMPurify needs a DOM, so on the server (no `window`) we strip all tags as a
 * conservative fallback. Comment HTML is only ever rendered client-side after
 * the threads are fetched, so this path is not normally exercised and never
 * causes a hydration mismatch.
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined") {
    return html.replace(/<[^>]*>/g, "");
  }
  return DOMPurify.sanitize(html);
}

import DOMPurify from "dompurify";

/**
 * Force every link in sanitized HTML to open in a new tab. Comment bodies are
 * rendered inside the app, so following a link in place would replace the
 * Docreview tab and lose the user's filter/scroll state. Any existing `target`
 * and `rel` are replaced outright, so a Drive-supplied `rel` is not preserved;
 * `noopener noreferrer` blocks the opened page from reaching back through
 * `window.opener`.
 *
 * `tagName` is upper-cased before comparing because SVG elements report a
 * lowercase `a` (Drive comment HTML has no SVG, but this costs nothing).
 * Links whose `href` DOMPurify rejected (e.g. `javascript:`) have no `href`
 * left by the time this runs, so they correctly get no target.
 */
export function applyLinkTarget(node: Element) {
  if (node.tagName.toUpperCase() === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
}

/**
 * Install the link hook, lazily.
 *
 * Two subtleties, both load-bearing:
 *  - This MUST NOT move to module scope. Without a `window`, DOMPurify's
 *    factory bails out early and the exported object has no `addHook` method
 *    at all, so a top-level call would throw when Next evaluates this module
 *    on the server.
 *  - `addHook` mutates the shared DOMPurify singleton, so the hook applies to
 *    every `DOMPurify.sanitize()` call in the app. That is fine today because
 *    this module is the only caller; a second caller that must not rewrite
 *    links would need its own scoped `DOMPurify(window)` instance.
 *
 * `target` is not in DOMPurify's default attribute allowlist — it survives
 * only because `afterSanitizeAttributes` runs after attribute validation and
 * nothing re-validates. An upgrade that changed that ordering would silently
 * break this.
 */
let hookInstalled = false;
function installTargetBlankHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", applyLinkTarget);
}

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
  installTargetBlankHook();
  return DOMPurify.sanitize(html);
}

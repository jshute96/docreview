import { parseGoogleDocId } from "@/lib/google-drive";
import { logInfo } from "@/lib/log";
import { isInternalGoLink, resolveInternalGoLink } from "@/lib/go-links";

/** Public URL shorteners safe to follow server-side. */
const PUBLIC_SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
]);

/** Is this a known public shortener URL that's safe to resolve server-side? */
export function isPublicShortenerUrl(input: string): boolean {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?([^\/\s]+)\/(.+)/);
  if (!match) return false;
  return PUBLIC_SHORTENER_HOSTS.has(match[1].toLowerCase());
}

/**
 * Try to resolve a shortened URL by following redirects server-side.
 * Returns the final URL if it redirected to a Google Doc, or null otherwise.
 * Only follows known public shorteners (SSRF mitigation).
 */
export async function tryResolveRedirect(url: string): Promise<string | null> {
  if (isInternalGoLink(url)) {
    return resolveInternalGoLink(url);
  }

  if (!isPublicShortenerUrl(url)) return null;

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

      // Only accept if it resolved to a Google Doc URL (mitigates SSRF)
      if (!parseGoogleDocId(resolved)) {
        logInfo("[Redirect]", `${fullUrl} → ${resolved} (not a Google Doc, ignoring)`);
        return null;
      }

      logInfo("[Redirect]", `${fullUrl} → ${resolved}`);
      return resolved;
    }
    logInfo("[Redirect]", `${fullUrl} — no redirect`);
    return null;
  } catch (err) {
    logInfo("[Redirect]", `${fullUrl} — failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Could this input be a shortened redirect URL (e.g. "go/my-doc", "http://go/my-doc")? */
export function looksLikeRedirectUrl(input: string): boolean {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?([^\/\s]+)\/(.+)/);
  if (!match) return false;
  if (match[1].endsWith("google.com")) return false;
  return true;
}

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

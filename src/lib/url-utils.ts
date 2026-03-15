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

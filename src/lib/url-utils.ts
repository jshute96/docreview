/** Could this input be a shortened redirect URL (e.g. "go/my-doc", "http://go/my-doc")? */
export function looksLikeRedirectUrl(input: string): boolean {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?([^\/\s]+)\/(.+)/);
  if (!match) return false;
  if (match[1].endsWith("google.com")) return false;
  return true;
}

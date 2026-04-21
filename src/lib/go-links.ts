/**
 * Basic internal go link resolution.
 */
export function isInternalGoLink(url: string): boolean {
  return url.startsWith("go/") || url.startsWith("http://go/") || url.startsWith("https://go/");
}

export function resolveInternalGoLink(url: string): string {
  // In a real internal environment, this would call a resolution API.
  // For now, we just return the link as-is or transform it to a known host.
  const path = url.replace(/^(https?:\/\/)?go\//, "");
  return `http://go/${path}`;
}

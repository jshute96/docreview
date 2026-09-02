/**
 * The Google Workspace MIME types this app tracks. Client-safe (no Drive
 * imports), so both server code and components can use the same constants
 * instead of repeating the literal strings.
 */
export const GoogleMimeType = {
  Doc: "application/vnd.google-apps.document",
  Sheet: "application/vnd.google-apps.spreadsheet",
  Slides: "application/vnd.google-apps.presentation",
} as const;

export type GoogleMimeType = (typeof GoogleMimeType)[keyof typeof GoogleMimeType];

/** Every type that can be added as a doc. */
export const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set(Object.values(GoogleMimeType));

/** Short label shown in the UI ("Docs", "Sheets", "Slides"). */
export const MIME_TYPE_LABELS = {
  [GoogleMimeType.Doc]: "Docs",
  [GoogleMimeType.Sheet]: "Sheets",
  [GoogleMimeType.Slides]: "Slides",
} as const satisfies Record<GoogleMimeType, string>;

/** Label for a MIME type that may be anything — falls back to the raw value. */
export function mimeTypeLabel(mimeType: string): string {
  return (MIME_TYPE_LABELS as Record<string, string>)[mimeType] ?? mimeType;
}

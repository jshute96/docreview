/**
 * Error codes returned as `{ error: <code> }` by the doc validate/add API routes,
 * so the client picks the wording instead of the server sending prose. The values
 * go over the wire, so changing one is a breaking change for both sides.
 */
export const DocErrorCode = {
  /** URL/ID isn't a recognizable Google Drive link. */
  InvalidUrl: "invalid_url",
  /** Not a Doc, Sheet, or Slides file. */
  InvalidMimeType: "invalid_mime_type",
  /** The file is in Drive's trash. */
  Trashed: "trashed",
  /**
   * Drive says the file is gone or not visible (403/404). Client-only — the
   * routes report this as a *successful* response carrying
   * `permissionDenied: true`, since the doc can still be tracked.
   */
  NoAccess: "no_access",
  /** Drive lookup failed for some other reason — transient, worth retrying. */
  LookupFailed: "lookup_failed",
} as const;

export type DocErrorCode = (typeof DocErrorCode)[keyof typeof DocErrorCode];

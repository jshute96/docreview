/** Validated scan/load options parsed from a request body. */
export interface LoadOptions {
  daysBack: number | null;
  ownership: "all" | "owned" | "shared-with-me";
  includeSharedDrives: boolean;
  source: "drive" | "gmail";
}

/**
 * Parse and validate scan/load options from a raw request body.
 * Returns safe defaults for missing or invalid values.
 */
export function parseLoadOptions(body: Record<string, unknown>): LoadOptions {
  const daysBack = body.daysBack === null
    ? null
    : Math.max(1, typeof body.daysBack === "number" ? body.daysBack : 30);
  const ownership = (
    typeof body.ownership === "string" &&
    ["all", "owned", "shared-with-me"].includes(body.ownership)
      ? body.ownership
      : "all"
  ) as LoadOptions["ownership"];
  const includeSharedDrives = body.includeSharedDrives === true;
  const source = (
    typeof body.source === "string" && ["drive", "gmail"].includes(body.source)
      ? body.source
      : "drive"
  ) as LoadOptions["source"];

  return { daysBack, ownership, includeSharedDrives, source };
}

import type { DocWithLabels } from "@/types";
import type { TriState } from "./tri-state";
import { partitionTriState } from "./tri-state";
import { matchesFilter } from "./highlight";

export type SortCol = "title" | "lastModifiedInDrive" | "unread" | "inbox" | "open";
export type SortDir = "asc" | "desc";

export interface FilterOptions {
  isInbox: TriState;
  hasComments: TriState;
  isAuthor: TriState;
  mimeTypes: Record<string, TriState>;
  labels: Record<string, TriState>;
  titleFilter: string;
}

export function filterDocs(
  docs: DocWithLabels[],
  opts: FilterOptions
): DocWithLabels[] {
  const mime = partitionTriState(opts.mimeTypes);
  const lbl = partitionTriState(opts.labels);

  return docs.filter((doc) => {
    // isInbox: include = inbox only, exclude = archived only, off = all
    if (opts.isInbox === "include" && doc.status === "ARCHIVED") return false;
    if (opts.isInbox === "exclude" && doc.status !== "ARCHIVED") return false;

    // hasComments: include = only with comments, exclude = only without
    if (opts.hasComments === "include" && doc._count.openComments === 0)
      return false;
    if (opts.hasComments === "exclude" && doc._count.openComments > 0)
      return false;

    // isAuthor: include = AUTHOR only, exclude = non-AUTHOR only
    if (opts.isAuthor === "include" && doc.role !== "AUTHOR") return false;
    if (opts.isAuthor === "exclude" && doc.role === "AUTHOR") return false;

    // mimeTypes: include = must match one (OR), exclude = must not match any
    const docMime = doc.mimeType ?? "";
    if (mime.include.length > 0 && !mime.include.includes(docMime))
      return false;
    if (mime.exclude.length > 0 && mime.exclude.includes(docMime)) return false;

    // labels: include = must have ALL (AND), exclude = must not have any
    if (
      lbl.include.length > 0 &&
      !lbl.include.every((id) => doc.labels.some((dl) => dl.labelId === id))
    )
      return false;
    if (
      lbl.exclude.length > 0 &&
      doc.labels.some((dl) => lbl.exclude.includes(dl.labelId))
    )
      return false;

    // titleFilter: searches title and notes
    if (opts.titleFilter) {
      const searchable = doc.title + (doc.notes ? " " + doc.notes : "");
      if (!matchesFilter(searchable, opts.titleFilter)) return false;
    }
    return true;
  });
}

export function sortDocs(
  docs: DocWithLabels[],
  col: SortCol,
  dir: SortDir
): DocWithLabels[] {
  return [...docs].sort((a, b) => {
    let cmp = 0;
    if (col === "title") {
      cmp = a.title.localeCompare(b.title);
    } else if (col === "unread") {
      cmp = a._count.unreadComments - b._count.unreadComments;
    } else if (col === "inbox") {
      cmp = a._count.inboxComments - b._count.inboxComments;
    } else if (col === "open") {
      cmp = a._count.openComments - b._count.openComments;
    } else {
      const aTime = a.lastModifiedInDrive
        ? new Date(a.lastModifiedInDrive).getTime()
        : 0;
      const bTime = b.lastModifiedInDrive
        ? new Date(b.lastModifiedInDrive).getTime()
        : 0;
      cmp = aTime - bTime;
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

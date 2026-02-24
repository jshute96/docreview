import type { DocWithLabels } from "@/types";

export type SortCol = "title" | "lastModifiedInDrive" | "watched" | "open";
export type SortDir = "asc" | "desc";

export interface FilterOptions {
  showArchived: boolean;
  hasCommentsFilter: boolean;
  roleFilter: "AUTHOR" | "NOT_AUTHOR" | null;
  selectedMimeTypes: string[];
  selectedLabelIds: string[];
  titleFilter: string;
}

export function filterDocs(
  docs: DocWithLabels[],
  opts: FilterOptions
): DocWithLabels[] {
  return docs.filter((doc) => {
    if (!opts.showArchived && doc.status === "ARCHIVED") return false;
    if (opts.hasCommentsFilter && doc._count.openComments === 0) return false;
    if (opts.roleFilter === "AUTHOR" && doc.role !== "AUTHOR") return false;
    if (opts.roleFilter === "NOT_AUTHOR" && doc.role === "AUTHOR") return false;
    if (
      opts.selectedMimeTypes.length > 0 &&
      !opts.selectedMimeTypes.includes(doc.mimeType ?? "")
    )
      return false;
    if (
      opts.selectedLabelIds.length > 0 &&
      !doc.labels.some((dl) => opts.selectedLabelIds.includes(dl.labelId))
    )
      return false;
    if (opts.titleFilter) {
      try {
        const re = new RegExp(opts.titleFilter, "i");
        if (!re.test(doc.title)) return false;
      } catch {
        // invalid regex — fall back to plain substring match
        if (!doc.title.toLowerCase().includes(opts.titleFilter.toLowerCase()))
          return false;
      }
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
    } else if (col === "watched") {
      cmp = a._count.watchedComments - b._count.watchedComments;
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

"use client";

import { useState } from "react";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { DocRow } from "@/components/doc-row";
import { FilterBar } from "@/components/filter-bar";
import { AddDocDialog } from "@/components/add-doc-dialog";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { RefreshButton } from "@/components/refresh-button";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

type SortCol = "title" | "lastModifiedInDrive" | "comments";
type SortDir = "asc" | "desc";

interface DocTableProps {
  initialDocs: DocWithLabels[];
  initialLabels: Label[];
}

export function DocTable({ initialDocs, initialLabels }: DocTableProps) {
  const [docs, setDocs] = useState<DocWithLabels[]>(initialDocs);
  const [labels, setLabelsRaw] = useState<Label[]>(initialLabels);

  // When labels change (e.g. color update), propagate into docs state too
  function setLabels(newLabels: Label[]) {
    setLabelsRaw(newLabels);
    const labelMap = new Map(newLabels.map((l) => [l.id, l]));
    setDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        labels: doc.labels.map((dl) => ({
          ...dl,
          label: labelMap.get(dl.labelId) ?? dl.label,
        })),
      }))
    );
  }
  const [showArchived, setShowArchived] = useState(false);
  const [hasCommentsFilter, setHasCommentsFilter] = useState(false);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [roleFilter, setRoleFilter] = useState<"AUTHOR" | "NOT_AUTHOR" | null>(null);
  const [selectedMimeTypes, setSelectedMimeTypes] = useState<string[]>([]);
  const [titleFilter, setTitleFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("lastModifiedInDrive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "lastModifiedInDrive" || col === "comments" ? "desc" : "asc");
    }
  }

  function handleLabelToggle(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  function handleDocUpdate(updated: DocWithLabels) {
    setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }

  function handleDocAdded(newDoc: DocWithLabels) {
    setDocs((prev) => [newDoc, ...prev]);
  }

  function handleLabelDelete(id: string) {
    setLabels(labels.filter((l) => l.id !== id));
    setDocs((prev) =>
      prev.map((d) => ({
        ...d,
        labels: d.labels.filter((dl) => dl.labelId !== id),
      }))
    );
    setSelectedLabelIds((prev) => prev.filter((l) => l !== id));
  }

  function handleMimeTypeToggle(mimeType: string) {
    setSelectedMimeTypes((prev) =>
      prev.includes(mimeType) ? prev.filter((m) => m !== mimeType) : [...prev, mimeType]
    );
  }

  const filteredDocs = docs
    .filter((doc) => {
      if (!showArchived && doc.status === "ARCHIVED") return false;
      if (hasCommentsFilter && doc._count.comments === 0) return false;
      if (roleFilter === "AUTHOR" && doc.role !== "AUTHOR") return false;
      if (roleFilter === "NOT_AUTHOR" && doc.role === "AUTHOR") return false;
      if (selectedMimeTypes.length > 0 && !selectedMimeTypes.includes(doc.mimeType ?? "")) return false;
      if (
        selectedLabelIds.length > 0 &&
        !doc.labels.some((dl) => selectedLabelIds.includes(dl.labelId))
      ) {
        return false;
      }
      if (titleFilter) {
        try {
          const re = new RegExp(titleFilter, "i");
          if (!re.test(doc.title)) return false;
        } catch {
          // invalid regex — fall back to plain substring match
          if (!doc.title.toLowerCase().includes(titleFilter.toLowerCase())) return false;
        }
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      if (sortCol === "title") {
        cmp = a.title.localeCompare(b.title);
      } else if (sortCol === "comments") {
        cmp = a._count.comments - b._count.comments;
      } else {
        const aTime = a.lastModifiedInDrive ? new Date(a.lastModifiedInDrive).getTime() : 0;
        const bTime = b.lastModifiedInDrive ? new Date(b.lastModifiedInDrive).getTime() : 0;
        cmp = aTime - bTime;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="ml-1 text-zinc-300">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, children }: { col: SortCol; children: React.ReactNode }) {
    return (
      <th className="px-4 py-2.5 text-left">
        <button
          onClick={() => handleSort(col)}
          className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
        >
          {children}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Your Docs</h1>
        <div className="flex items-center gap-2">
          <AddDocDialog allLabels={labels} onDocAdded={handleDocAdded} />
          <ManageLabelsDialog labels={labels} onLabelsChange={setLabels} onLabelDelete={handleLabelDelete} />
          <RefreshButton onRefresh={(newDocs) => setDocs(newDocs)} />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            Sign out
          </Button>
        </div>
      </div>

      <FilterBar
        labels={labels}
        showArchived={showArchived}
        hasCommentsFilter={hasCommentsFilter}
        selectedLabelIds={selectedLabelIds}
        roleFilter={roleFilter}
        selectedMimeTypes={selectedMimeTypes}
        titleFilter={titleFilter}
        onShowArchivedChange={setShowArchived}
        onHasCommentsFilterChange={setHasCommentsFilter}
        onLabelToggle={handleLabelToggle}
        onRoleFilterChange={setRoleFilter}
        onMimeTypeToggle={handleMimeTypeToggle}
        onTitleFilterChange={setTitleFilter}
      />

      {filteredDocs.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {docs.length === 0
            ? 'No docs yet. Click "Refresh" to sync.'
            : "No docs match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="w-px px-4 py-2.5" />
                <ThButton col="title">Title</ThButton>
                <ThButton col="comments">Comments</ThButton>
                <ThButton col="lastModifiedInDrive">Last Modified</ThButton>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide text-left">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filteredDocs.map((doc) => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  allLabels={labels}
                  onUpdate={handleDocUpdate}
                  onArchive={() => {}}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

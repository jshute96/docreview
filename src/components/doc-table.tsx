"use client";

import { useState } from "react";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import type { TriState } from "@/lib/tri-state";
import { DocRow } from "@/components/doc-row";
import { FilterBar } from "@/components/filter-bar";
import { AddDocDialog } from "@/components/add-doc-dialog";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { RefreshButton } from "@/components/refresh-button";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { filterDocs, sortDocs } from "@/lib/doc-filters";
import type { SortCol, SortDir } from "@/lib/doc-filters";

interface DocTableProps {
  initialDocs: DocWithLabels[];
  initialLabels: Label[];
  isOffline?: boolean;
}

export function DocTable({ initialDocs, initialLabels, isOffline }: DocTableProps) {
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

  const [isActive, setIsActive] = useState<TriState>("include");
  const [hasComments, setHasComments] = useState<TriState>("off");
  const [isAuthor, setIsAuthor] = useState<TriState>("off");
  const [mimeTypes, setMimeTypes] = useState<Record<string, TriState>>({});
  const [labelsFilter, setLabelsFilter] = useState<Record<string, TriState>>({});
  const [titleFilter, setTitleFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("lastModifiedInDrive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "lastModifiedInDrive" || col === "watched" || col === "open" ? "desc" : "asc");
    }
  }

  function handleTriStateChange(
    setter: React.Dispatch<React.SetStateAction<Record<string, TriState>>>,
    key: string,
    value: TriState
  ) {
    setter((prev) => {
      // Remove entry when cycling back to off to keep state clean
      if (value === "off") {
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: value };
    });
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
    setLabelsFilter((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }

  const filteredDocs = sortDocs(
    filterDocs(docs, {
      isActive,
      hasComments,
      isAuthor,
      mimeTypes,
      labels: labelsFilter,
      titleFilter,
    }),
    sortCol,
    sortDir
  );

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="ml-1 text-zinc-300">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, rowSpan, title, children }: { col: SortCol; rowSpan?: number; title?: string; children: React.ReactNode }) {
    return (
      <th className="px-4 py-2.5 text-left" rowSpan={rowSpan}>
        <button
          onClick={() => handleSort(col)}
          title={title}
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
          <RefreshButton mode="refresh" onRefresh={(newDocs) => setDocs(newDocs)} />
          <RefreshButton mode="full-refresh" onRefresh={(newDocs) => setDocs(newDocs)} />
          <RefreshButton mode="load" onRefresh={(newDocs) => setDocs(newDocs)} />
          <ManageLabelsDialog labels={labels} onLabelsChange={setLabels} onLabelDelete={handleLabelDelete} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/login" })}
            disabled={isOffline}
            title="Sign out of your account"
            className={isOffline ? "opacity-50 cursor-not-allowed" : ""}
          >
            Sign out
          </Button>
        </div>
      </div>

      <FilterBar
        labels={labels}
        isActive={isActive}
        hasComments={hasComments}
        isAuthor={isAuthor}
        mimeTypes={mimeTypes}
        labelsFilter={labelsFilter}
        titleFilter={titleFilter}
        onIsActiveChange={setIsActive}
        onHasCommentsChange={setHasComments}
        onIsAuthorChange={setIsAuthor}
        onMimeTypeChange={(mt, v) => handleTriStateChange(setMimeTypes, mt, v)}
        onLabelChange={(id, v) => handleTriStateChange(setLabelsFilter, id, v)}
        onTitleFilterChange={setTitleFilter}
      />

      {filteredDocs.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {docs.length === 0
            ? 'No docs yet. Use "Add doc" or "Load from Drive" to add docs.'
            : "No docs match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50">
                <ThButton col="title" rowSpan={2} title="Document title">Title</ThButton>
                <th colSpan={2} className="px-4 pt-2 pb-0 text-center text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Comments
                </th>
                <ThButton col="lastModifiedInDrive" rowSpan={2} title="Last change time">Last Modified</ThButton>
                <th rowSpan={2} className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide text-left">
                  Actions
                </th>
              </tr>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <ThButton col="watched" title="Comments in my threads and my docs">Watched</ThButton>
                <ThButton col="open" title="All open comments">Open</ThButton>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filteredDocs.map((doc) => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  allLabels={labels}
                  onUpdate={handleDocUpdate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

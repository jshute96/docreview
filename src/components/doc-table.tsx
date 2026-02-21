"use client";

import { useState } from "react";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { DocRow } from "@/components/doc-row";
import { FilterBar } from "@/components/filter-bar";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { RefreshButton } from "@/components/refresh-button";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

interface DocTableProps {
  initialDocs: DocWithLabels[];
  initialLabels: Label[];
}

export function DocTable({ initialDocs, initialLabels }: DocTableProps) {
  const [docs, setDocs] = useState<DocWithLabels[]>(initialDocs);
  const [labels, setLabels] = useState<Label[]>(initialLabels);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);

  function handleLabelToggle(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  function handleDocUpdate(updated: DocWithLabels) {
    setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }

  function handleDocArchive(id: string) {
    // If not showing archived, hide the doc
    if (!showArchived) {
      setDocs((prev) => prev.filter((d) => d.id !== id));
    }
  }

  const filteredDocs = docs.filter((doc) => {
    if (!showArchived && doc.status === "ARCHIVED") return false;
    if (
      selectedLabelIds.length > 0 &&
      !doc.labels.some((dl) => selectedLabelIds.includes(dl.labelId))
    ) {
      return false;
    }
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Your Docs</h1>
        <div className="flex items-center gap-2">
          <ManageLabelsDialog labels={labels} onLabelsChange={setLabels} />
          <RefreshButton />
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
        selectedLabelIds={selectedLabelIds}
        onShowArchivedChange={setShowArchived}
        onLabelToggle={handleLabelToggle}
      />

      {filteredDocs.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {docs.length === 0
            ? 'No docs yet. Click "Refresh from Drive" to sync.'
            : "No docs match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Title
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Role
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Last Modified
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Status
                </th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 uppercase tracking-wide">
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
                  onArchive={(id) => {
                    if (!showArchived) {
                      setDocs((prev) => prev.filter((d) => d.id !== id));
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

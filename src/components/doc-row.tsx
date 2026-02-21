"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { LabelBadge } from "@/components/label-badge";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { Button } from "@/components/ui/button";

interface DocRowProps {
  doc: DocWithLabels;
  allLabels: Label[];
  onUpdate: (updated: DocWithLabels) => void;
  onArchive: (id: string) => void;
}

export function DocRow({ doc, allLabels, onUpdate, onArchive }: DocRowProps) {
  const [archiving, setArchiving] = useState(false);

  async function handleArchive() {
    setArchiving(true);
    try {
      const newStatus = doc.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
      const res = await fetch(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      onUpdate(updated);
      if (newStatus === "ARCHIVED") onArchive(doc.id);
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Restored");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  const lastModified = doc.lastModifiedInDrive
    ? new Date(doc.lastModifiedInDrive).toLocaleDateString()
    : "—";

  return (
    <tr className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors">
      <td className="py-3 pr-4">
        <a
          href={doc.driveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-zinc-900 hover:underline hover:text-blue-600"
        >
          {doc.title}
        </a>
        {doc.labels.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {doc.labels.map((dl) => (
              <LabelBadge key={dl.labelId} label={dl.label} />
            ))}
          </div>
        )}
      </td>
      <td className="py-3 pr-4">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            doc.role === "AUTHOR"
              ? "bg-blue-100 text-blue-700"
              : "bg-zinc-100 text-zinc-600"
          }`}
        >
          {doc.role.charAt(0) + doc.role.slice(1).toLowerCase()}
        </span>
      </td>
      <td className="py-3 pr-4 text-sm text-zinc-500">{lastModified}</td>
      <td className="py-3 pr-4">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            doc.status === "ACTIVE"
              ? "bg-green-100 text-green-700"
              : "bg-zinc-100 text-zinc-500"
          }`}
        >
          {doc.status.charAt(0) + doc.status.slice(1).toLowerCase()}
        </span>
      </td>
      <td className="py-3">
        <div className="flex items-center gap-1">
          <EditDocDialog doc={doc} allLabels={allLabels} onSave={onUpdate}>
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              Edit
            </Button>
          </EditDocDialog>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === "ACTIVE" ? "Archive" : "Restore"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

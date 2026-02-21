"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { LabelBadge } from "@/components/label-badge";
import { ROLE_COLORS } from "@/lib/role-colors";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { DocTypeIcon } from "@/components/doc-type-icon";
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
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  const lastModified = doc.lastModifiedInDrive
    ? (() => {
        const d = new Date(doc.lastModifiedInDrive!);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      })()
    : "—";

  return (
    <tr className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors">
      <td className="py-1.5 pr-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={doc.driveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 text-sm font-medium hover:underline hover:text-blue-600 ${
              doc.isDeleted ? "line-through text-zinc-400" : "text-zinc-900"
            }`}
          >
            <DocTypeIcon mimeType={doc.mimeType} />
            {doc.title}
          </a>
          {doc.role === "AUTHOR" && (
            <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${ROLE_COLORS.AUTHOR.badge}`}>
              Author
            </span>
          )}
          {doc.labels.map((dl) => (
            <LabelBadge key={dl.labelId} label={dl.label} />
          ))}
        </div>
      </td>
      <td className="py-1.5 pr-4 text-sm text-zinc-500">{lastModified}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-1">
          <EditDocDialog doc={doc} allLabels={allLabels} onSave={onUpdate}>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
              Edit
            </Button>
          </EditDocDialog>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === "ACTIVE" ? "Archive" : "Unarchive"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

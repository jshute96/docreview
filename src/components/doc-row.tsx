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
import { formatDate } from "@/lib/utils";

interface DocRowProps {
  doc: DocWithLabels;
  allLabels: Label[];
  onUpdate: (updated: DocWithLabels) => void;
}

export function DocRow({ doc, allLabels, onUpdate }: DocRowProps) {
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
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  const lastModified = formatDate(doc.lastModifiedInDrive);

  return (
    <tr className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors">
      <td className="py-1.5 pl-4 pr-4">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/docs/${doc.id}`}
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
      <td className="py-1.5 pr-4 text-sm text-zinc-500">
        {doc._count.comments > 0 ? doc._count.comments : ""}
      </td>
      <td className="py-1.5 pr-4 text-sm text-zinc-500">{lastModified}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" asChild>
            <a href={doc.driveUrl} target="_blank" rel="noopener noreferrer">Open</a>
          </Button>
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

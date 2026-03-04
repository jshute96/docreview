"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { DocWithLabels } from "@/types";
import { LabelBadge } from "@/components/label-badge";
import { ROLE_COLORS } from "@/lib/role-colors";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { highlightText } from "@/lib/highlight";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId } from "@/lib/api-fetch";
import { INBOX_COMMENTS_TOOLTIP, OPEN_COMMENTS_TOOLTIP } from "@/lib/tooltips";

interface DocRowProps {
  doc: DocWithLabels;
  onUpdate: (updated: DocWithLabels) => void;
  searchFilter?: string;
}

export function DocRow({
  doc,
  onUpdate,
  searchFilter = "",
}: DocRowProps) {
  const [archiving, setArchiving] = useState(false);

  async function handleArchive() {
    setArchiving(true);
    const contextId = generateContextId();
    try {
      const newStatus = doc.status === "INBOX" ? "ARCHIVED" : "INBOX";
      const res = await apiFetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "docs", docId: doc.docId }, contextId);
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  const lastModified = formatDate(doc.lastModifiedInDrive);
  const hasNotes = !!doc.notes?.trim();
  const notesTooltip = hasNotes
    ? doc.notes!.split("\n").slice(0, 20).join("\n") + (doc.notes!.split("\n").length > 20 ? "\n…" : "")
    : "";

  return (
    <tr className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors">
      <td className={`pl-4 pr-4 ${hasNotes ? "pt-1.5 pb-0.5" : "py-1.5"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/comments/${doc.docId}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open document comments page"
            className={`inline-flex items-center gap-1.5 text-sm font-medium hover:underline hover:text-blue-600 ${
              doc.isDeleted ? "line-through text-zinc-400" : "text-zinc-900"
            }`}
          >
            <DocTypeIcon mimeType={doc.mimeType} />
            <span>{highlightText(doc.title, searchFilter)}</span>
          </a>
          {doc.role === "AUTHOR" && (
            <span title="You are an author of this document" className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${ROLE_COLORS.AUTHOR.badge}`}>
              Author
            </span>
          )}
          {doc.labels.map((dl) => (
            <LabelBadge key={dl.labelId} label={dl.label} />
          ))}
        </div>
        {hasNotes && (
          <p className="truncate text-sm text-zinc-400 w-0 min-w-full" title={notesTooltip}>
            <span className="text-zinc-500">Notes: </span>
            <span>{highlightText(doc.notes!.replace(/\n/g, " "), searchFilter)}</span>
          </p>
        )}
      </td>
      <td className="py-1.5 px-4 text-sm text-zinc-500">
        <div 
          className="mx-auto w-8 text-right -translate-x-2" 
          title={doc._count.inboxComments > 0 ? INBOX_COMMENTS_TOOLTIP : undefined}
        >
          {doc._count.inboxComments > 0 ? doc._count.inboxComments : ""}
        </div>
      </td>
      <td className="py-1.5 px-4 text-sm text-zinc-500">
        <div 
          className="mx-auto w-8 text-right -translate-x-3" 
          title={doc._count.openComments > 0 ? OPEN_COMMENTS_TOOLTIP : undefined}
        >
          {doc._count.openComments > 0 ? doc._count.openComments : ""}
        </div>
      </td>
      <td className="py-1.5 pr-4 text-sm text-zinc-500">{lastModified}</td>
      <td className="py-1.5 pr-4">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Open this document" asChild>
            <a href={doc.driveUrl} target="_blank" rel="noopener noreferrer">Open</a>
          </Button>
          <EditDocDialog
            doc={doc}
            onSave={onUpdate}
          >
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Edit document labels and notes">
              Edit
            </Button>
          </EditDocDialog>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={doc.status === "INBOX" ? "Archive this document" : "Move to inbox"}
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === "INBOX" ? "Archive" : "Unarchive"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

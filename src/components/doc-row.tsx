"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { DocWithLabels } from "@/types";
import { LabelBadge } from "@/components/label-badge";
import { ROLE_COLORS } from "@/lib/role-colors";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { Button } from "@/components/ui/button";
import { FriendlyDate } from "@/components/friendly-date";
import { highlightText } from "@/lib/highlight";
import { StarButton } from "@/components/star-button";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId } from "@/lib/api-fetch";
import { UNREAD_COMMENTS_TOOLTIP, INBOX_COMMENTS_TOOLTIP, OPEN_COMMENTS_TOOLTIP } from "@/lib/tooltips";
import { commentsTarget, docTarget } from "@/lib/tab-targets";
import { handleOpenDocClick } from "@/lib/extension-bridge";

interface DocRowProps {
  doc: DocWithLabels;
  onUpdate: (updated: DocWithLabels) => void;
  searchFilter?: string;
  cachedTitle?: string;
}

export function DocRow({
  doc,
  onUpdate,
  searchFilter = "",
  cachedTitle,
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
      broadcastChange({ type: "docs", docIds: [doc.docId] }, contextId);
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  async function handleToggleStar() {
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: !doc.isStarred }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "docs", docIds: [doc.docId] }, contextId);
    } catch {
      toast.error("Failed to update star");
    }
  }

  function handleOpenDoc(e: React.MouseEvent<HTMLAnchorElement>) {
    handleOpenDocClick(e, doc.googleDocId, doc.driveUrl, docTarget(doc.googleDocId));
  }

  const hasNotes = !!doc.notes?.trim();
  const notOk = doc.accessState !== "OK";
  const hasSubline = hasNotes || notOk;
  const notesTooltip = hasNotes
    ? doc.notes!.split("\n").slice(0, 20).join("\n") + (doc.notes!.split("\n").length > 20 ? "\n…" : "")
    : "";

  return (
    <tr className={`border-b border-zinc-100 transition-colors ${
      doc._count.assignedComments > 0
        ? "bg-red-100 hover:bg-red-200"
        : doc._count.mentionedComments > 0
        ? "bg-amber-100 hover:bg-amber-200"
        : "hover:bg-zinc-50"
    }`}>
      <td className={`pl-4 pr-0 ${hasSubline ? "pt-1.5 pb-0.5" : "py-1.5"} w-0`}>
        <div className="flex items-center h-5">
          <StarButton starred={doc.isStarred} onToggle={handleToggleStar} />
        </div>
      </td>
      <td className={`pl-2 pr-4 ${hasSubline ? "pt-1.5 pb-0.5" : "py-1.5"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/comments/${doc.docId}`}
            target={commentsTarget(doc.googleDocId)}
            title="Open document comments page"
            className={`inline-flex items-center gap-1.5 text-sm font-medium hover:underline hover:text-blue-600 ${
              notOk ? "line-through text-zinc-400" : "text-zinc-900"
            }`}
          >
            <DocTypeIcon mimeType={doc.mimeType} />
            <span suppressHydrationWarning className={!cachedTitle && !doc.title ? "italic text-zinc-400" : undefined}>
              {highlightText(cachedTitle || doc.title || "Unknown title", searchFilter)}
            </span>
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
        {(notOk || hasNotes) && (
          <p className="truncate text-sm text-zinc-400 w-0 min-w-full" title={notesTooltip}>
            {doc.accessState === "DENIED" && <span className="text-red-500">(Permission denied) </span>}
            {doc.accessState === "TRASHED" && <span className="text-red-500">(In trash) </span>}
            {doc.accessState === "NOT_FOUND" && <span className="text-red-500">(Not accessible) </span>}
            {hasNotes && (
              <>
                <span className="text-zinc-500">Notes: </span>
                <span>{highlightText(doc.notes!.replace(/\n/g, " "), searchFilter)}</span>
              </>
            )}
          </p>
        )}
      </td>
      <td className="py-1.5 px-1 text-sm text-zinc-500 w-12">
        <div className="mx-auto w-5 text-right translate-x-0.5" title={doc._count.unreadComments > 0 ? UNREAD_COMMENTS_TOOLTIP : undefined}>
          {doc._count.unreadComments > 0 ? doc._count.unreadComments : ""}
        </div>
      </td>
      <td className="py-1.5 px-1 text-sm text-zinc-500 w-12">
        <div className="mx-auto w-5 text-right translate-x-1" title={doc._count.inboxComments > 0 ? INBOX_COMMENTS_TOOLTIP : undefined}>
          {doc._count.inboxComments > 0 ? doc._count.inboxComments : ""}
        </div>
      </td>
      <td className="py-1.5 px-1 text-sm text-zinc-500 w-12">
        <div className="mx-auto w-5 text-right -translate-x-0.5" title={doc._count.openComments > 0 ? OPEN_COMMENTS_TOOLTIP : undefined}>
          {doc._count.openComments > 0 ? doc._count.openComments : ""}
        </div>
      </td>
      <td className="py-1.5 pr-4 text-sm text-zinc-500"><FriendlyDate date={doc.lastModifiedInDrive} /></td>
      <td className="py-1.5 pr-4">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Open this document" asChild>
            <a href={doc.driveUrl} target={docTarget(doc.googleDocId)} onClick={handleOpenDoc}>Open</a>
          </Button>
          <EditDocDialog
            doc={doc}
            cachedTitle={cachedTitle}
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

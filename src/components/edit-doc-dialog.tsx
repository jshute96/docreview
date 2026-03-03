"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import type { DocWithLabels } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_COLORS, STATUS_COLORS } from "@/lib/role-colors";
import { LabelPicker } from "@/components/label-picker";
import { DialogButtons } from "@/components/dialog-buttons";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { broadcastChange } from "@/lib/cross-tab";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { useLabelSync } from "@/hooks/use-label-sync";
import { useLabels } from "@/contexts/label-context";

interface EditDocDialogProps {
  doc: DocWithLabels;
  onSave: (updated: DocWithLabels) => void;
  children: React.ReactNode;
}

export function EditDocDialog({
  doc,
  onSave,
  children,
}: EditDocDialogProps) {
  const { allLabels } = useLabels();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(doc.role);
  const [status, setStatus] = useState(doc.status);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>(
    doc.labels.map((dl) => dl.labelId)
  );
  const [notes, setNotes] = useState(doc.notes ?? "");
  const [saving, setSaving] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useLabelSync(allLabels, setSelectedLabelIds);
  const autoResize = useAutoResize(notesRef, notes);
  useEffect(() => { if (open) requestAnimationFrame(autoResize); }, [open, autoResize]);

  function toggleLabel(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, status, labelIds: selectedLabelIds, notes }),
      });
      if (!res.ok) throw new Error("Save failed");
      const updated: DocWithLabels = await res.json();
      onSave(updated);
      setOpen(false);
      broadcastChange({ type: "docs", docId: doc.docId });
      toast.success("Saved");
    } catch {
      toast.error("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (v) {
        // Reset on open
        setRole(doc.role);
        setStatus(doc.status);
        setSelectedLabelIds(doc.labels.map((dl) => dl.labelId));
        setNotes(doc.notes ?? "");
      }
      setOpen(v);
    }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="line-clamp-1">Edit Document</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col gap-4 p-6 pt-1">
            <a
              href={doc.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              draggable="false"
              title="Open document"
              className={`flex items-center gap-1.5 text-base hover:text-blue-600 hover:underline line-clamp-1 ${
                doc.isDeleted ? "line-through text-zinc-400" : "text-zinc-600"
              }`}
            >
              <DocTypeIcon mimeType={doc.mimeType} className="h-4 w-4 flex-shrink-0" />
              {doc.title}
            </a>

            <div className="flex gap-8">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
                  Role
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRole(role === "AUTHOR" ? "REVIEWER" : "AUTHOR")}
                    title="You are an author of this document"
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      role === "AUTHOR"
                        ? ROLE_COLORS.AUTHOR.activeFilter
                        : ROLE_COLORS.AUTHOR.inactiveFilter
                    }`}
                  >
                    Author
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
                  State
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setStatus(status === "INBOX" ? "ARCHIVED" : "INBOX")}
                    title={status === "INBOX" ? "This document is in inbox" : "This document is archived"}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      status === "INBOX"
                        ? STATUS_COLORS.INBOX.activeFilter
                        : STATUS_COLORS.INBOX.inactiveFilter
                    }`}
                  >
                    Inbox
                  </button>
                </div>
              </div>
            </div>

            <LabelPicker
              selectedLabelIds={selectedLabelIds}
              onToggle={toggleLabel}
            />

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
                Notes
              </label>
              <textarea
                ref={notesRef}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes…"
                rows={1}
                className={`${TEXTAREA_CLASSES} w-full max-h-[200px]`}
              />
            </div>
          </div>
        </div>

        <div className="p-6 pt-0">
          <DialogButtons
            onConfirm={handleSave}
            onCancel={() => setOpen(false)}
            confirmLabel={saving ? "Saving…" : "Save"}
            disabled={saving}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

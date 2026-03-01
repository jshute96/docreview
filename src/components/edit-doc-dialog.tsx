"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_COLORS } from "@/lib/role-colors";
import { LabelPicker } from "@/components/label-picker";
import { DialogButtons } from "@/components/dialog-buttons";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";

interface EditDocDialogProps {
  doc: DocWithLabels;
  allLabels: Label[];
  onSave: (updated: DocWithLabels) => void;
  onLabelsChange: (labels: Label[]) => void;
  onLabelDelete: (id: string) => void;
  children: React.ReactNode;
}

export function EditDocDialog({
  doc,
  allLabels,
  onSave,
  onLabelsChange,
  onLabelDelete,
  children,
}: EditDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(doc.role);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>(
    doc.labels.map((dl) => dl.labelId)
  );
  const [notes, setNotes] = useState(doc.notes ?? "");
  const [saving, setSaving] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSelectedLabelIds((prev) =>
      prev.filter((id) => allLabels.some((l) => l.id === id))
    );
  }, [allLabels]);

  const autoResize = useCallback(() => {
    const ta = notesRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const capped = ta.scrollHeight > 200;
    ta.style.height = (capped ? 200 : ta.scrollHeight) + "px";
    ta.style.overflowY = capped ? "auto" : "hidden";
  }, []);

  useEffect(() => { autoResize(); }, [notes, autoResize]);
  // Re-measure after dialog mounts (ref not yet attached during state reset)
  useEffect(() => { if (open) requestAnimationFrame(autoResize); }, [open, autoResize]);

  function toggleLabel(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, labelIds: selectedLabelIds, notes }),
      });
      if (!res.ok) throw new Error("Save failed");
      const updated: DocWithLabels = await res.json();
      onSave(updated);
      setOpen(false);
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
        setSelectedLabelIds(doc.labels.map((dl) => dl.labelId));
        setNotes(doc.notes ?? "");
      }
      setOpen(v);
    }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="line-clamp-1">Edit Document</DialogTitle>
          <a
            href={doc.driveUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open document"
            className={`flex items-center gap-1.5 text-base hover:text-blue-600 hover:underline line-clamp-1 ${
              doc.isDeleted ? "line-through text-zinc-400" : "text-zinc-600"
            }`}
          >
            <DocTypeIcon mimeType={doc.mimeType} className="h-4 w-4 flex-shrink-0" />
            {doc.title}
          </a>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4">
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

          <LabelPicker
            allLabels={allLabels}
            selectedLabelIds={selectedLabelIds}
            onToggle={toggleLabel}
            onLabelsChange={onLabelsChange}
            onLabelDelete={onLabelDelete}
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

        <DialogButtons
          onConfirm={handleSave}
          onCancel={() => setOpen(false)}
          confirmLabel={saving ? "Saving…" : "Save"}
          disabled={saving}
        />
      </DialogContent>
    </Dialog>
  );
}

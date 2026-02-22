"use client";

import { useState } from "react";
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

interface EditDocDialogProps {
  doc: DocWithLabels;
  allLabels: Label[];
  onSave: (updated: DocWithLabels) => void;
  children: React.ReactNode;
}

export function EditDocDialog({
  doc,
  allLabels,
  onSave,
  children,
}: EditDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(doc.role);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>(
    doc.labels.map((dl) => dl.labelId)
  );
  const [saving, setSaving] = useState(false);

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
        body: JSON.stringify({ role, labelIds: selectedLabelIds }),
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
      }
      setOpen(v);
    }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="line-clamp-1">{doc.title}</DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-500 uppercase tracking-wide">
              Role
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setRole(role === "AUTHOR" ? "REVIEWER" : "AUTHOR")}
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

          <LabelPicker allLabels={allLabels} selectedLabelIds={selectedLabelIds} onToggle={toggleLabel} />
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

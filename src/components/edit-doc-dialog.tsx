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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

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
              {(["AUTHOR", "REVIEWER"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    role === r
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  }`}
                >
                  {r.charAt(0) + r.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {allLabels.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Labels
              </label>
              <div className="flex flex-col gap-1.5">
                {allLabels.map((label) => (
                  <label
                    key={label.id}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedLabelIds.includes(label.id)}
                      onCheckedChange={() => toggleLabel(label.id)}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: label.color ?? "#e4e4e7" }}
                    />
                    <span className="text-sm text-zinc-800">{label.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Label } from "@prisma/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#6b7280", // gray
];

interface ManageLabelsDialogProps {
  labels: Label[];
  onLabelsChange: (labels: Label[]) => void;
  onLabelDelete: (id: string) => void;
}

export function ManageLabelsDialog({
  labels,
  onLabelsChange,
  onLabelDelete,
}: ManageLabelsDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed");
      }
      const label: Label = await res.json();
      onLabelsChange([...labels, label]);
      setName("");
      toast.success(`Label "${label.name}" created`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create label");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/labels/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      onLabelDelete(id);
      toast.success("Label deleted");
    } catch {
      toast.error("Failed to delete label");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Manage Labels
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Labels</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleCreate} className="flex flex-col gap-3 mt-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label name…"
              className="flex-1 rounded-md border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
            />
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              Add
            </Button>
          </div>
          <div className="flex gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`h-6 w-6 rounded-full transition-transform ${
                  color === c ? "scale-125 ring-2 ring-offset-1 ring-zinc-400" : ""
                }`}
                style={{ backgroundColor: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </form>

        <div className="mt-4 flex flex-col gap-1">
          {labels.length === 0 && (
            <p className="text-sm text-zinc-400">No labels yet.</p>
          )}
          {labels.map((label) => (
            <div
              key={label.id}
              className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-zinc-50"
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: label.color ?? "#e4e4e7" }}
                />
                <span className="text-sm text-zinc-800">{label.name}</span>
              </div>
              <button
                onClick={() => handleDelete(label.id)}
                className="text-xs text-zinc-400 hover:text-red-500"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

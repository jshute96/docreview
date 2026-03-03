"use client";

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { GripVertical, Trash2 } from "lucide-react";
import type { Label } from "@prisma/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ColorPicker, PRIMARY_COLORS } from "@/components/color-picker";
import { DialogButtons } from "@/components/dialog-buttons";
import { broadcastChange } from "@/lib/cross-tab";
import { useLabels } from "@/contexts/label-context";

function randomPrimaryColor(): string {
  return PRIMARY_COLORS[Math.floor(Math.random() * PRIMARY_COLORS.length)];
}

interface ManageLabelsDialogProps {
  trigger?: React.ReactNode;
}

export function ManageLabelsDialog({
  trigger,
}: ManageLabelsDialogProps) {
  const { allLabels: labels, onLabelsChange, onLabelDelete } = useLabels();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Buffered local state — only committed on Save
  const [draft, setDraft] = useState<Label[]>([]);
  const nextTempId = useRef(0);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [colorChanges, setColorChanges] = useState<Map<string, string>>(new Map());

  // Pointer-based drag reorder (no ghost image)
  const dragIndexRef = useRef<number | null>(null);
  const rowRectsRef = useRef<DOMRect[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragActiveIndex, setDragActiveIndex] = useState<number | null>(null);

  const handlePointerDown = useCallback((index: number, e: React.PointerEvent) => {
    e.preventDefault();
    dragIndexRef.current = index;
    setDragging(true);
    setDragActiveIndex(index);

    // Snapshot row positions at drag start
    if (listRef.current) {
      const rows = listRef.current.querySelectorAll<HTMLElement>("[data-label-row]");
      rowRectsRef.current = Array.from(rows).map((r) => r.getBoundingClientRect());
    }

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null) return;

    const rects = rowRectsRef.current;
    if (rects.length === 0) return;

    // Find which row the pointer is over by comparing Y midpoints
    const y = e.clientY;
    let toIndex = fromIndex;
    for (let i = 0; i < rects.length; i++) {
      const mid = rects[i].top + rects[i].height / 2;
      if (y < mid) {
        toIndex = i;
        break;
      }
      toIndex = i;
    }

    if (toIndex !== fromIndex) {
      setDraft((prev) => {
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      });
      dragIndexRef.current = toIndex;
      setDragActiveIndex(toIndex);

      // Re-snapshot after reorder on next frame
      requestAnimationFrame(() => {
        if (listRef.current) {
          const rows = listRef.current.querySelectorAll<HTMLElement>("[data-label-row]");
          rowRectsRef.current = Array.from(rows).map((r) => r.getBoundingClientRect());
        }
      });
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    dragIndexRef.current = null;
    rowRectsRef.current = [];
    setDragging(false);
    setDragActiveIndex(null);
  }, []);

  function handleOpen(isOpen: boolean) {
    if (isOpen) {
      // Reset draft to current labels
      setDraft([...labels]);
      setAddedIds(new Set());
      setDeletedIds(new Set());
      setColorChanges(new Map());
      setName("");
    }
    setOpen(isOpen);
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const trimmed = name.trim();
    if (draft.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      toast.error("A label with that name already exists");
      return;
    }
    const tempId = `__temp_${nextTempId.current++}`;
    const newLabel: Label = {
      labelId: tempId,
      userId: "",
      name: trimmed,
      color: randomPrimaryColor(),
      position: draft.length,
    };
    setDraft((prev) => [...prev, newLabel]);
    setAddedIds((prev) => new Set(prev).add(tempId));
    setName("");
  }

  function handleColorChange(label: Label, color: string) {
    setDraft((prev) =>
      prev.map((l) => (l.labelId === label.labelId ? { ...l, color } : l))
    );
    if (!addedIds.has(label.labelId)) {
      setColorChanges((prev) => new Map(prev).set(label.labelId, color));
    }
  }

  function handleDelete(id: string) {
    setDraft((prev) => prev.filter((l) => l.labelId !== id));
    if (addedIds.has(id)) {
      // Was never persisted — just remove from added set
      setAddedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      setDeletedIds((prev) => new Set(prev).add(id));
      // No need to patch color for a deleted label
      setColorChanges((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function handleCancel() {
    setOpen(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // 1. Delete labels
      for (const id of deletedIds) {
        const res = await fetch(`/api/labels/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed to delete label");
        onLabelDelete(id);
      }

      // 2. Create new labels
      const tempToReal = new Map<string, Label>();
      for (const tempId of addedIds) {
        const tempLabel = draft.find((l) => l.labelId === tempId);
        if (!tempLabel) continue;
        const res = await fetch("/api/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tempLabel.name, color: tempLabel.color }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed to create label");
        }
        const created: Label = await res.json();
        tempToReal.set(tempId, created);
      }

      // 3. Update colors
      for (const [id, color] of colorChanges) {
        const res = await fetch(`/api/labels/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color }),
        });
        if (!res.ok) throw new Error("Failed to update label color");
      }

      // Build final labels list: start from draft, replace temp IDs with real ones
      const finalLabels = draft.map((l) => tempToReal.get(l.labelId) ?? l);

      // 4. Persist label order
      const orderIds = finalLabels.map((l) => l.labelId);
      const reorderRes = await fetch("/api/labels/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderIds }),
      });
      if (!reorderRes.ok) throw new Error("Failed to save label order");

      onLabelsChange(finalLabels);
      setOpen(false);
      broadcastChange({ type: "labels" });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save labels");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" title="Create or edit labels">
            Manage Labels
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md flex flex-col" hideClose>
        <DialogHeader>
          <DialogTitle>Manage Labels</DialogTitle>
        </DialogHeader>

        <div className="px-6 pt-4 pb-2">
          <form onSubmit={handleAdd} className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label name…"
              className="flex-1 rounded-md border border-zinc-200 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-zinc-300"
            />
            <Button type="submit" variant="outline" size="sm" disabled={!name.trim()}>
              Add
            </Button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-2">
          <div
            ref={listRef}
            className="flex flex-col gap-1"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {draft.length === 0 && (
              <p className="text-sm text-zinc-400">No labels yet.</p>
            )}
            {draft.map((label, index) => (
              <div
                key={label.labelId}
                data-label-row
                className={`flex items-center justify-between rounded-md px-2 py-1.5 select-none touch-none ${
                  dragActiveIndex === index
                    ? "bg-zinc-100 ring-1 ring-zinc-300 cursor-grabbing"
                    : "hover:bg-zinc-50 cursor-grab"
                } ${dragging ? "cursor-grabbing" : ""}`}
                onPointerDown={(e) => handlePointerDown(index, e)}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => handleDelete(label.labelId)}
                    className={`text-zinc-500 ${dragging ? "" : "hover:text-red-500"}`}
                    aria-label={`Delete ${label.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <GripVertical className="h-4 w-4 text-zinc-300 flex-shrink-0" />
                  <ColorPicker
                    color={label.color ?? "#e4e4e7"}
                    onChange={(c) => handleColorChange(label, c)}
                  >
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      className="h-4 w-4 rounded-full cursor-pointer ring-1 ring-zinc-200 hover:ring-zinc-400"
                      style={{ backgroundColor: label.color ?? "#e4e4e7" }}
                      aria-label={`Change color for ${label.name}`}
                    />
                  </ColorPicker>
                  <span className="text-sm text-zinc-800">{label.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 pt-2">
          <DialogButtons
            onConfirm={handleSave}
            onCancel={handleCancel}
            confirmLabel={saving ? "Saving…" : "Save"}
            disabled={saving}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

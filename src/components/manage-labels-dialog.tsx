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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { ColorPicker, PRIMARY_COLORS } from "@/components/color-picker";
import { DialogButtons } from "@/components/dialog-buttons";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import { useLabels } from "@/contexts/label-context";
import type { LabelWithCount } from "@/types";

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
  const [draft, setDraft] = useState<LabelWithCount[]>([]);
  const nextTempId = useRef(0);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [colorChanges, setColorChanges] = useState<Map<string, string>>(new Map());

  // Delete confirmation
  const [labelToDelete, setLabelToDelete] = useState<LabelWithCount | null>(null);

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

  async function handleOpen(isOpen: boolean) {
    if (isOpen) {
      // Reset draft to current labels initially
      setDraft([...labels]);
      setAddedIds(new Set());
      setDeletedIds(new Set());
      setColorChanges(new Map());
      setName("");

      // Refresh labels with counts from the server
      try {
        const res = await apiFetch("/api/labels");
        if (res.ok) {
          const latest: LabelWithCount[] = await res.json();
          setDraft(latest);
        }
      } catch {
        // Fallback to initial labels if fetch fails
      }
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
    const newLabel: LabelWithCount = {
      labelId: tempId,
      userId: "",
      name: trimmed,
      color: randomPrimaryColor(),
      position: draft.length,
      _count: { docs: 0 },
    };
    setDraft((prev) => [...prev, newLabel]);
    setAddedIds((prev) => new Set(prev).add(tempId));
    setName("");
  }

  function handleColorChange(label: LabelWithCount, color: string) {
    setDraft((prev) =>
      prev.map((l) => (l.labelId === label.labelId ? { ...l, color } : l))
    );
    if (!addedIds.has(label.labelId)) {
      setColorChanges((prev) => new Map(prev).set(label.labelId, color));
    }
  }

  function handleDelete(id: string) {
    const label = draft.find((l) => l.labelId === id);
    if (!label) return;
    setLabelToDelete(label);
  }

  function confirmDelete() {
    if (!labelToDelete) return;
    const id = labelToDelete.labelId;
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
    setLabelToDelete(null);
  }

  function handleCancel() {
    setOpen(false);
  }

  async function handleSave() {
    setSaving(true);
    const contextId = generateContextId();
    try {
      // 1. Delete labels
      for (const id of deletedIds) {
        const res = await apiFetch(`/api/labels/${id}`, { method: "DELETE", contextId });
        if (!res.ok) throw new Error("Failed to delete label");
        onLabelDelete(id);
      }

      // 2. Create new labels
      const tempToReal = new Map<string, LabelWithCount>();
      for (const tempId of addedIds) {
        const tempLabel = draft.find((l) => l.labelId === tempId);
        if (!tempLabel) continue;
        const res = await apiFetch("/api/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tempLabel.name, color: tempLabel.color }),
          contextId,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed to create label");
        }
        const created: LabelWithCount = await res.json();
        tempToReal.set(tempId, created);
      }

      // 3. Update colors
      for (const [id, color] of colorChanges) {
        const res = await apiFetch(`/api/labels/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color }),
          contextId,
        });
        if (!res.ok) throw new Error("Failed to update label color");
      }

      // Build final labels list: start from draft, replace temp IDs with real ones,
      // and update position fields to match the new array order.
      const finalLabels = draft.map((l, i) => {
        const resolved = tempToReal.get(l.labelId) ?? l;
        return { ...resolved, position: i };
      });

      // 4. Persist label order
      const orderIds = finalLabels.map((l) => l.labelId);
      const reorderRes = await apiFetch("/api/labels/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderIds }),
        contextId,
      });
      if (!reorderRes.ok) throw new Error("Failed to save label order");

      onLabelsChange(finalLabels);
      setOpen(false);
      broadcastChange({ type: "labels" }, contextId);
    } catch (err: unknown) {
      if (!isAuthError(err)) toast.error(err instanceof Error ? err.message : "Failed to save labels");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" title="Create or edit labels">
            Labels
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md flex flex-col" hideClose aria-describedby={undefined}>
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
                title={`Label ${label.name} is attached to ${label._count?.docs ?? 0} documents`}
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
                      className="h-4 w-4 rounded-full  ring-1 ring-zinc-200 hover:ring-zinc-400"
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

      <AlertDialog open={!!labelToDelete} onOpenChange={(o) => !o && setLabelToDelete(null)}>
        <AlertDialogContent aria-describedby={undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Label {labelToDelete?.name} is attached to {labelToDelete?._count?.docs ?? 0} documents. Delete it?
            </AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className={buttonVariants({ variant: "outline" })}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

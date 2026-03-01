"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Plus, HelpCircle, X } from "lucide-react";
import type { DocWithLabels } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_COLORS } from "@/lib/role-colors";
import { DialogButtons } from "@/components/dialog-buttons";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { BulkEditState, cycleBulkEditState } from "@/lib/bulk-edit";
import { contrastText } from "@/lib/utils";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { Button } from "@/components/ui/button";
import { broadcastChange } from "@/lib/cross-tab";
import { useLabels } from "@/contexts/label-context";

interface BulkEditDialogProps {
  initialDocs: DocWithLabels[];
  onSave: (updatedDocs: DocWithLabels[]) => void;
  children: React.ReactNode;
}

/**
 * Checks if all, none, or a mix of documents satisfy a predicate.
 */
function checkConsistency(docs: DocWithLabels[], predicate: (d: DocWithLabels) => boolean) {
  if (docs.length === 0) return { all: false, none: true, mixed: false };
  const all = docs.every(predicate);
  const none = docs.every(d => !predicate(d));
  return { all, none, mixed: !all && !none };
}

/**
 * Visual indicator for the tri-state buttons.
 */
function StateIndicator({ state, isMixed }: { state: BulkEditState; isMixed: boolean }) {
  if (state === "as-is") {
    return isMixed ? (
      <HelpCircle className="absolute -top-1.5 -right-1.5 h-3.5 w-3.5 fill-white text-zinc-500" />
    ) : null;
  }
  return (
    <span className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/20 bg-blue-600 text-white shadow-sm">
      {state === "set" ? (
        <Plus className="h-2.5 w-2.5 stroke-[3]" />
      ) : (
        <div className="h-0.5 w-2 rounded-full bg-white" />
      )}
    </span>
  );
}

export function BulkEditDialog({
  initialDocs,
  onSave,
  children,
}: BulkEditDialogProps) {
  const { allLabels } = useLabels();
  const [open, setOpen] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<DocWithLabels[]>(initialDocs);
  const [roleState, setRoleState] = useState<BulkEditState>("as-is");
  const [labelStates, setLabelStates] = useState<Record<string, BulkEditState>>({});
  const [appendNotes, setAppendNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (isOpen) {
      setSelectedDocs(initialDocs);
      setAppendNotes("");
      setRoleState("as-is");
      const initialLabelStates: Record<string, BulkEditState> = {};
      allLabels.forEach(label => { initialLabelStates[label.id] = "as-is"; });
      setLabelStates(initialLabelStates);
    }
    setOpen(isOpen);
  }, [initialDocs, allLabels]);

  function handleRemoveDoc(id: string) {
    const next = selectedDocs.filter(d => d.id !== id);
    setSelectedDocs(next);

    // Revert role/label states to 'as-is' if they've become redundant (no-op)
    // for the remaining documents in the selection. This ensures we don't 
    // perform unnecessary database updates.
    const role = checkConsistency(next, d => d.role === "AUTHOR");
    if ((roleState === "set" && role.all) || (roleState === "clear" && role.none)) {
      setRoleState("as-is");
    }

    setLabelStates(current => {
      const updated = { ...current };
      allLabels.forEach(l => {
        const label = checkConsistency(next, d => d.labels.some(dl => dl.labelId === l.id));
        if ((updated[l.id] === "set" && label.all) || (updated[l.id] === "clear" && label.none)) {
          updated[l.id] = "as-is";
        }
      });
      return updated;
    });
  }

  function cycleRole(e: React.MouseEvent) {
    // Prevent interaction with the underlying dialog/overlay when clicking toggles
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(selectedDocs, d => d.role === "AUTHOR");
    setRoleState(prev => {
      // Skip redundant states: 
      // If all are authors, skip 'set' (+). If none are authors, skip 'clear' (-).
      if (all) return prev === "as-is" ? "clear" : "as-is";
      if (none) return prev === "as-is" ? "set" : "as-is";
      return cycleBulkEditState(prev);
    });
  }

  function cycleLabel(labelId: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(selectedDocs, d => d.labels.some(dl => dl.labelId === labelId));
    setLabelStates(prev => {
      const current = prev[labelId] ?? "as-is";
      let next: BulkEditState;
      // Consistent with cycleRole: automatically skip states that are redundant for the selection.
      if (all) next = current === "as-is" ? "clear" : "as-is";
      else if (none) next = current === "as-is" ? "set" : "as-is";
      else next = cycleBulkEditState(current);
      return { ...prev, [labelId]: next };
    });
  }

  const autoResize = useCallback(() => {
    const ta = notesRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const capped = ta.scrollHeight > 150;
    ta.style.height = (capped ? 150 : ta.scrollHeight) + "px";
    ta.style.overflowY = capped ? "auto" : "hidden";
  }, []);

  useEffect(() => { autoResize(); }, [appendNotes, autoResize]);

  async function handleSave() {
    if (selectedDocs.length === 0) {
      toast.error("No documents selected");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/docs/bulk-update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docIds: selectedDocs.map(d => d.id),
          role: roleState,
          labelUpdates: labelStates,
          appendNotes: appendNotes.trim(),
        }),
      });
      if (!res.ok) throw new Error("Bulk update failed");
      const { docs: updatedDocs, skipped } = (await res.json()) as {
        docs: DocWithLabels[];
        skipped: number;
      };
      onSave(updatedDocs);
      setOpen(false);
      broadcastChange({ type: "docs" });
      toast.success(`Updated ${updatedDocs.length} documents`);
      if (skipped > 0) {
        toast.warning(`${skipped} document${skipped === 1 ? " was" : "s were"} not found`);
      }
    } catch {
      toast.error("Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  const role = checkConsistency(selectedDocs, d => d.role === "AUTHOR");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {selectedDocs.length} Document{selectedDocs.length === 1 ? "" : "s"}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col gap-6 p-6 pt-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-900">
                Role
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cycleRole}
                  className={`relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    roleState === "set" || roleState === "clear" || (roleState === "as-is" && role.all)
                      ? ROLE_COLORS.AUTHOR.activeFilter
                      : ROLE_COLORS.AUTHOR.inactiveFilter
                  }`}
                >
                  Author
                  <StateIndicator state={roleState} isMixed={role.mixed} />
                </button>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <label className="text-xs font-medium uppercase tracking-wide text-zinc-900">
                  Labels
                </label>
                <ManageLabelsDialog
                  trigger={
                    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" title="Edit labels">
                      Edit
                    </Button>
                  }
                />
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                {allLabels.map((label) => {
                  const bg = label.color ?? "#e4e4e7";
                  const state = labelStates[label.id] ?? "as-is";
                  const { all: allHave, mixed: isMixed } = checkConsistency(selectedDocs, d => d.labels.some(dl => dl.labelId === label.id));
                  const active = state === "set" || state === "clear" || (state === "as-is" && allHave);

                  return (
                    <button
                      key={label.id}
                      type="button"
                      onClick={(e) => cycleLabel(label.id, e)}
                      className={`relative rounded-full px-2 py-0.5 text-xs font-medium transition-opacity ${
                        active ? "opacity-100 ring-2 ring-offset-1 ring-zinc-400" : "opacity-40 hover:opacity-70"
                      }`}
                      style={{ backgroundColor: bg, color: contrastText(bg) }}
                    >
                      {label.name}
                      <StateIndicator state={state} isMixed={isMixed} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-900">
                Append Notes
              </label>
              <textarea
                ref={notesRef}
                value={appendNotes}
                onChange={(e) => setAppendNotes(e.target.value)}
                placeholder="Append notes..."
                rows={1}
                className={`${TEXTAREA_CLASSES} max-h-[150px] w-full`}
              />
            </div>

            <div 
              className="overflow-hidden rounded-md border border-zinc-200 bg-zinc-50/50 flex flex-col"
              style={{ 
                maxHeight: `clamp(calc(5 * 1.5rem + 2px), 30vh, calc(15 * 1.5rem + 2px))`,
                minHeight: selectedDocs.length > 0 ? `calc(${Math.min(selectedDocs.length, 5)} * 1.5rem + 2px)` : "auto",
              }}
            >
              <div className="max-w-full overflow-auto">
                {selectedDocs.length === 0 ? (
                  <div className="py-4 text-center text-xs italic text-zinc-400">No documents selected</div>
                ) : (
                  <div className="flex flex-col">
                    {selectedDocs.map((doc) => (
                      <div key={doc.id} className="flex h-6 min-w-max items-center gap-2 px-2 transition-colors hover:bg-zinc-100">
                        <button
                          onClick={() => handleRemoveDoc(doc.id)}
                          className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
                          title="Remove from list"
                          aria-label={`Remove ${doc.title}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                        <a 
                          href={`/comments/${doc.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open document comments page"
                          className={`flex items-center gap-2 transition-colors hover:text-blue-600 hover:underline ${
                            doc.isDeleted ? "text-zinc-400 line-through" : ""
                          }`}
                        >
                          <DocTypeIcon mimeType={doc.mimeType} className={`h-3 w-3 flex-shrink-0 ${doc.isDeleted ? "text-zinc-300" : ""}`} />
                          <span className="whitespace-nowrap pr-4 text-xs font-medium">
                            {doc.title}
                          </span>
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 pt-0">
          <DialogButtons
            onConfirm={handleSave}
            onCancel={() => setOpen(false)}
            confirmLabel={saving ? "Saving…" : "Save Changes"}
            disabled={saving || selectedDocs.length === 0}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

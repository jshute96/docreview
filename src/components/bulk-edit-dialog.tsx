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
import { ROLE_COLORS, STATUS_COLORS } from "@/lib/role-colors";
import { DialogButtons } from "@/components/dialog-buttons";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { BulkEditState, cycleBulkEditState } from "@/lib/bulk-edit";
import { Star } from "lucide-react";
import { contrastText } from "@/lib/utils";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { Button } from "@/components/ui/button";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId } from "@/lib/api-fetch";
import { useLabels } from "@/contexts/label-context";
import { useMultiSelect } from "@/hooks/use-multi-select";

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
  const [statusState, setStatusState] = useState<BulkEditState>("as-is");
  const [starState, setStarState] = useState<BulkEditState>("as-is");
  const [labelStates, setLabelStates] = useState<Record<string, BulkEditState>>({});
  const [appendNotes, setAppendNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [docListRows, setDocListRows] = useState(5);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const {
    highlightedIds, effectiveItems: effectiveDocs, handleRowClick,
    removeFromHighlight, clearHighlights, reset: resetHighlights, rowClassName,
  } = useMultiSelect(selectedDocs, d => d.docId);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (isOpen) {
      setSelectedDocs(initialDocs);
      setAppendNotes("");
      setRoleState("as-is");
      setStatusState("as-is");
      setStarState("as-is");
      const initialLabelStates: Record<string, BulkEditState> = {};
      allLabels.forEach(label => { initialLabelStates[label.labelId] = "as-is"; });
      setLabelStates(initialLabelStates);
      setDocListRows(Math.min(15, Math.max(5, initialDocs.length)));
      resetHighlights();
    }
    setOpen(isOpen);
  }, [initialDocs, allLabels]);

  /**
   * Revert role/status/label states to 'as-is' if they've become redundant
   * (no-op) for the remaining documents. Prevents unnecessary DB updates.
   */
  function revertRedundantStates(remainingDocs: DocWithLabels[]) {
    const role = checkConsistency(remainingDocs, d => d.role === "AUTHOR");
    if ((roleState === "set" && role.all) || (roleState === "clear" && role.none)) {
      setRoleState("as-is");
    }

    const status = checkConsistency(remainingDocs, d => d.status === "INBOX");
    if ((statusState === "set" && status.all) || (statusState === "clear" && status.none)) {
      setStatusState("as-is");
    }

    const star = checkConsistency(remainingDocs, d => d.isStarred);
    if ((starState === "set" && star.all) || (starState === "clear" && star.none)) {
      setStarState("as-is");
    }

    setLabelStates(current => {
      const updated = { ...current };
      allLabels.forEach(l => {
        const label = checkConsistency(remainingDocs, d => d.labels.some(dl => dl.labelId === l.labelId));
        if ((updated[l.labelId] === "set" && label.all) || (updated[l.labelId] === "clear" && label.none)) {
          updated[l.labelId] = "as-is";
        }
      });
      return updated;
    });
  }

  function handleRemoveDoc(id: string) {
    const next = selectedDocs.filter(d => d.docId !== id);
    setSelectedDocs(next);
    removeFromHighlight(id);
    revertRedundantStates(next);
  }

  function handleRemoveHighlighted() {
    const removed = clearHighlights();
    const next = selectedDocs.filter(d => !removed.has(d.docId));
    setSelectedDocs(next);
    revertRedundantStates(next);
  }

  function cycleRole(e: React.MouseEvent) {
    // Prevent interaction with the underlying dialog/overlay when clicking toggles
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(effectiveDocs, d => d.role === "AUTHOR");
    setRoleState(prev => {
      // Skip redundant states:
      // If all are authors, skip 'set' (+). If none are authors, skip 'clear' (-).
      if (all) return prev === "as-is" ? "clear" : "as-is";
      if (none) return prev === "as-is" ? "set" : "as-is";
      return cycleBulkEditState(prev);
    });
  }

  function cycleStatus(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(effectiveDocs, d => d.status === "INBOX");
    setStatusState(prev => {
      if (all) return prev === "as-is" ? "clear" : "as-is";
      if (none) return prev === "as-is" ? "set" : "as-is";
      return cycleBulkEditState(prev);
    });
  }

  function cycleStar(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(effectiveDocs, d => d.isStarred);
    setStarState(prev => {
      if (all) return prev === "as-is" ? "clear" : "as-is";
      if (none) return prev === "as-is" ? "set" : "as-is";
      return cycleBulkEditState(prev);
    });
  }

  function cycleLabel(labelId: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const { all, none } = checkConsistency(effectiveDocs, d => d.labels.some(dl => dl.labelId === labelId));
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
    if (effectiveDocs.length === 0) {
      toast.error("No documents selected");
      return;
    }
    setSaving(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch("/api/docs/bulk-update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docIds: effectiveDocs.map(d => d.docId),
          role: roleState,
          status: statusState,
          isStarred: starState,
          labelUpdates: labelStates,
          appendNotes: appendNotes.trim(),
        }),
        contextId,
      });
      if (!res.ok) throw new Error("Bulk update failed");
      const { docs: updatedDocs, skipped } = (await res.json()) as {
        docs: DocWithLabels[];
        skipped: number;
      };
      onSave(updatedDocs);
      setOpen(false);
      broadcastChange({ type: "docs" }, contextId);
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

  const role = checkConsistency(effectiveDocs, d => d.role === "AUTHOR");
  const status = checkConsistency(effectiveDocs, d => d.status === "INBOX");
  const star = checkConsistency(effectiveDocs, d => d.isStarred);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {effectiveDocs.length} Document{effectiveDocs.length === 1 ? "" : "s"}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          <div className="flex flex-col gap-6 px-6 pt-4 pb-0 shrink-0">
            <div className="flex gap-8">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-900">
                  Role
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={cycleRole}
                    title={"Set Author vs Reviewer state.\nIn Author state, all new comments go to your Inbox."}
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
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-900">
                  State
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={cycleStatus}
                    title="Set Inbox vs Archived state"
                    className={`relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      statusState === "set" || statusState === "clear" || (statusState === "as-is" && status.all)
                        ? STATUS_COLORS.INBOX.activeFilter
                        : STATUS_COLORS.INBOX.inactiveFilter
                    }`}
                  >
                    Inbox
                    <StateIndicator state={statusState} isMixed={status.mixed} />
                  </button>
                </div>
              </div>

              <div className="flex flex-col items-center">
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-900">
                  Star
                </label>
                <div className="flex items-center py-1.5">
                  <button
                    type="button"
                    onClick={cycleStar}
                    title="Set starred state"
                    className="relative"
                  >
                    <Star
                      className={`h-6 w-6 transition-colors ${
                        starState === "set" || (starState === "as-is" && star.all)
                          ? "text-amber-400"
                          : "text-zinc-300 hover:text-zinc-400"
                      }`}
                      fill={starState === "set" || (starState === "as-is" && star.all) ? "currentColor" : "none"}
                    />
                    <StateIndicator state={starState} isMixed={star.mixed} />
                  </button>
                </div>
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
                  const state = labelStates[label.labelId] ?? "as-is";
                  const { all: allHave, mixed: isMixed } = checkConsistency(effectiveDocs, d => d.labels.some(dl => dl.labelId === label.labelId));
                  const active = state === "set" || state === "clear" || (state === "as-is" && allHave);

                  return (
                    <button
                      key={label.labelId}
                      type="button"
                      onClick={(e) => cycleLabel(label.labelId, e)}
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
          </div>

          <div
            tabIndex={-1}
            onKeyDown={(e) => {
              if ((e.key === "Delete" || e.key === "Backspace") && highlightedIds.size > 0) {
                e.preventDefault();
                handleRemoveHighlighted();
              }
            }}
            className="mx-6 overflow-y-auto overflow-x-hidden rounded-md border border-zinc-200 bg-zinc-50/50 outline-none shrink"
            style={{
              height: `calc(${docListRows} * 1.5rem + 2px)`,
              minHeight: `calc(5 * 1.5rem + 2px)`,
              maxHeight: `calc(15 * 1.5rem + 2px)`,
            }}
          >
            {selectedDocs.length === 0 ? (
              <div className="py-4 text-center text-xs italic text-zinc-400">No documents selected</div>
            ) : (
              <div className="flex flex-col">
                {selectedDocs.map((doc) => (
                  <div
                    key={doc.docId}
                    onClick={(e) => handleRowClick(doc.docId, e)}
                    className={rowClassName(doc.docId, "flex h-6 min-w-max items-center gap-2 px-2 transition-colors")}
                  >
                    <button
                      onClick={() => handleRemoveDoc(doc.docId)}
                      className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
                      title="Remove from list"
                      aria-label={`Remove ${doc.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                    <span
                      onDoubleClick={() => window.open(`/comments/${doc.docId}`, "_blank")}
                      title="Click to select, double-click to open"
                      className={`flex items-center gap-2 ${
                        doc.accessState !== "OK" ? "text-zinc-400 line-through" : ""
                      }`}
                    >
                      <DocTypeIcon mimeType={doc.mimeType} className={`h-3 w-3 flex-shrink-0 ${doc.accessState !== "OK" ? "text-zinc-300" : ""}`} />
                      <span className="whitespace-nowrap pr-4 text-xs font-medium">
                        {doc.title}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="mx-6 mt-1 text-sm text-zinc-400 shrink-0">Click to select, double-click to open</p>
        </div>

        <div className="p-6 pt-0">
          <DialogButtons
            onConfirm={handleSave}
            onCancel={() => setOpen(false)}
            confirmLabel={saving ? "Saving…" : "Save Changes"}
            disabled={saving || effectiveDocs.length === 0}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

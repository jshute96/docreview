"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
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
import { DialogButtons } from "@/components/dialog-buttons";
import { LabelPicker } from "@/components/label-picker";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { broadcastChange } from "@/lib/cross-tab";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { useLabelSync } from "@/hooks/use-label-sync";

interface AddDocDialogProps {
  allLabels: Label[];
  onDocAdded: (doc: DocWithLabels) => void;
  onLabelsChange: (labels: Label[]) => void;
  onLabelDelete: (id: string) => void;
  trigger?: React.ReactNode;
}

type ValidationState = "idle" | "validating" | "valid" | "invalid";

function errorMessageForCode(code: string): string {
  switch (code) {
    case "invalid_url":
      return "Not a recognized Google Drive URL";
    case "invalid_mime_type":
      return "Only Docs, Sheets, and Slides are supported";
    case "already_exists":
      return "This document is already in your list";
    case "trashed":
      return "This document is in the trash";
    case "no_access":
      return "Document not found or you don't have access";
    default:
      return "Validation failed";
  }
}

export function AddDocDialog({
  allLabels,
  onDocAdded,
  onLabelsChange,
  onLabelDelete,
  trigger,
}: AddDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [validationState, setValidationState] = useState<ValidationState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validTitle, setValidTitle] = useState<string | null>(null);
  const [validMimeType, setValidMimeType] = useState<string | null>(null);
  const [existingDocId, setExistingDocId] = useState<string | null>(null);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useLabelSync(allLabels, setSelectedLabelIds);
  const autoResize = useAutoResize(notesRef, notes);
  useEffect(() => { if (open) requestAnimationFrame(autoResize); }, [open, autoResize]);

  function toggleLabel(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  async function validateUrl(urlToValidate: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    setValidationState("validating");

    try {
      const res = await fetch(
        `/api/docs/validate?url=${encodeURIComponent(urlToValidate)}`,
        { signal: controller.signal }
      );
      const data = await res.json();
      if (res.ok) {
        setValidTitle(data.title ?? null);
        setValidMimeType(data.mimeType ?? null);
        setValidationState("valid");
      } else {
        if (data.title) setValidTitle(data.title);
        if (data.mimeType) setValidMimeType(data.mimeType);
        if (data.error === "already_exists") {
          setExistingDocId(data.id ?? null);
        }
        setValidationState("invalid");
        setValidationError(errorMessageForCode(data.error));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setValidationState("invalid");
      setValidationError("Validation failed");
    }
  }

  function handleUrlChange(newUrl: string) {
    setUrl(newUrl);
    setValidationState("idle");
    setValidationError(null);
    setValidTitle(null);
    setValidMimeType(null);
    setExistingDocId(null);

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!newUrl.trim()) return;

    debounceRef.current = setTimeout(() => {
      validateUrl(newUrl);
    }, 250);
  }

  async function handleAdd() {
    setAdding(true);
    try {
      const res = await fetch("/api/docs/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, labelIds: selectedLabelIds, notes }),
      });
      if (!res.ok) throw new Error("Add failed");
      const newDoc: DocWithLabels = await res.json();
      onDocAdded(newDoc);
      setOpen(false);
      broadcastChange({ type: "docs" });
      toast.success(`Added "${newDoc.title}"`);
    } catch {
      toast.error("Failed to add document");
    } finally {
      setAdding(false);
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  function ValidationIcon() {
    switch (validationState) {
      case "idle":
        return <CheckCircle2 className="h-4 w-4 text-zinc-300" />;
      case "validating":
        return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
      case "valid":
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case "invalid":
        return <XCircle className="h-4 w-4 text-red-500" />;
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) {
          setUrl("");
          setValidationState("idle");
          setValidationError(null);
          setValidTitle(null);
          setValidMimeType(null);
          setExistingDocId(null);
          setSelectedLabelIds([]);
          setNotes("");
          setAdding(false);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          if (abortRef.current) abortRef.current.abort();
        }
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" title="Add a Google Drive document by URL">
            Add doc
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Document</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col gap-4 p-6 pt-4">
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="url"
                  placeholder="https://docs.google.com/..."
                  value={url}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
                />
                <ValidationIcon />
              </div>
              {validationError && (
                <p className="mt-1 text-xs text-red-500">{validationError}</p>
              )}
              {validTitle && (
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 line-clamp-1" title={validTitle}>
                    <DocTypeIcon mimeType={validMimeType} className="h-4 w-4 flex-shrink-0" />
                    {validTitle}
                  </p>
                  {existingDocId && (
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs flex-shrink-0" title="Open document comments page" asChild>
                      <a href={`/comments/${existingDocId}`}>Open</a>
                    </Button>
                  )}
                </div>
              )}
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
        </div>

        <div className="p-6 pt-0">
          <DialogButtons
            onConfirm={handleAdd}
            onCancel={() => setOpen(false)}
            confirmLabel={adding ? "Adding…" : "Add"}
            disabled={validationState !== "valid" || adding}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

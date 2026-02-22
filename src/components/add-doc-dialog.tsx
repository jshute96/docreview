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
import { LabelPicker } from "@/components/label-picker";

interface AddDocDialogProps {
  allLabels: Label[];
  onDocAdded: (doc: DocWithLabels) => void;
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

export function AddDocDialog({ allLabels, onDocAdded }: AddDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [validationState, setValidationState] = useState<ValidationState>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const validTitleRef = useRef<string | null>(null);

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
        validTitleRef.current = data.title ?? null;
        setValidationState("valid");
      } else {
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
        body: JSON.stringify({ url, labelIds: selectedLabelIds }),
      });
      if (!res.ok) throw new Error("Add failed");
      const newDoc: DocWithLabels = await res.json();
      onDocAdded(newDoc);
      setOpen(false);
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
          setSelectedLabelIds([]);
          setAdding(false);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          if (abortRef.current) abortRef.current.abort();
        }
        setOpen(v);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Add
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Document</DialogTitle>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4">
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
          </div>

          <LabelPicker
            allLabels={allLabels}
            selectedLabelIds={selectedLabelIds}
            onToggle={toggleLabel}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={validationState !== "valid" || adding}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

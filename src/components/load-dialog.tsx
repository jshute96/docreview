"use client";

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { apiFetch, isAuthError } from "@/lib/api-fetch";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { LabelPicker } from "@/components/label-picker";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { useAutoResize } from "@/hooks/use-auto-resize";
import { useLabelSync } from "@/hooks/use-label-sync";
import { useLabels } from "@/contexts/label-context";
import type { DocWithLabels } from "@/types";
import { broadcastChange } from "@/lib/cross-tab";

interface LoadOptions {
  daysBack: number;
  ownership: "all" | "owned" | "shared-with-me";
  includeSharedDrives: boolean;
}

interface ScanDoc {
  googleDocId: string;
  title: string;
  mimeType: string;
  driveUrl: string;
  owner: string | null;
  role: "AUTHOR" | "REVIEWER";
}

interface ScanResult {
  total: number;
  existingCount: number;
  newDocs: ScanDoc[];
}

const DEFAULT_OPTIONS: LoadOptions = {
  daysBack: 30,
  ownership: "all",
  includeSharedDrives: false,
};

interface LoadDialogProps {
  onRefresh: (docs: DocWithLabels[]) => void;
}

export function LoadDialog({ onRefresh }: LoadDialogProps) {
  const { allLabels } = useLabels();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<LoadOptions>(DEFAULT_OPTIONS);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<ScanDoc[]>([]);
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useAutoResize(notesRef, notes);
  useLabelSync(allLabels, setSelectedLabelIds);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (isOpen) {
      setScanResult(null);
      setSelectedDocs([]);
      setSelectedLabelIds([]);
      setNotes("");
    } else {
      abortRef.current?.abort();
    }
    setOpen(isOpen);
  }, []);

  function handleCancel() {
    abortRef.current?.abort();
    setOpen(false);
  }

  function toggleLabel(id: string) {
    setSelectedLabelIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  }

  async function handleScan() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setScanning(true);
    setScanResult(null);
    try {
      const res = await apiFetch("/api/docs/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Scan failed");
      const result: ScanResult = await res.json();
      setScanResult(result);
      setSelectedDocs(result.newDocs);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (!isAuthError(err)) toast.error("Failed to scan Google Drive");
    } finally {
      setScanning(false);
    }
  }

  async function handleAdd() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAdding(true);
    try {
      const syncRes = await apiFetch("/api/docs?mode=load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...options,
          selectedGoogleDocIds: selectedDocs.map((d) => d.googleDocId),
          labelIds: selectedLabelIds,
          notes,
        }),
        signal: controller.signal,
      });
      if (!syncRes.ok) throw new Error("Sync failed");
      const data = await syncRes.json();

      const docsRes = await fetch("/api/docs?includeArchived=true", {
        signal: controller.signal,
      });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      broadcastChange({ type: "docs" });
      setOpen(false);

      const parts = [
        data.added > 0 ? `${data.added} new` : "",
        data.updated > 0 ? `${data.updated} updated` : "",
        data.deleted > 0 ? `${data.deleted} deleted` : "",
      ]
        .filter(Boolean)
        .join(", ");
      toast.success(`Load complete — ${parts || "no updates"}`, {
        duration: 8000,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      if (!isAuthError(err)) toast.error("Failed to sync with Google Drive");
    } finally {
      setAdding(false);
    }
  }

  const docsRemoved =
    scanResult !== null && selectedDocs.length < scanResult.newDocs.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={adding}
          title="Discover documents from Google Drive"
        >
          Load…
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Load from Drive</DialogTitle>
          <DialogDescription>
            Discover documents from Google Drive and sync their comments.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          <div className="flex flex-col gap-4 px-6 py-4 shrink-0">
            {/* Days back */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="load-days-back"
                className="text-sm font-medium text-zinc-700"
              >
                Time window
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="load-days-back"
                  type="number"
                  min={1}
                  max={365}
                  value={options.daysBack}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1 && v <= 365) {
                      setOptions((o) => ({ ...o, daysBack: v }));
                    }
                  }}
                  className="w-20 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="text-sm text-zinc-500">
                  days back from today
                </span>
              </div>
            </div>

            {/* Ownership filter */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">
                Which documents
              </label>
              <Select
                value={options.ownership}
                onValueChange={(v) =>
                  setOptions((o) => ({
                    ...o,
                    ownership: v as LoadOptions["ownership"],
                  }))
                }
              >
                <SelectTrigger className="w-full bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accessible docs</SelectItem>
                  <SelectItem value="owned">Only docs I own</SelectItem>
                  <SelectItem value="shared-with-me">
                    Only docs shared with me
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-400">
                {options.ownership === "all" &&
                  "Everything you can access in Google Drive."}
                {options.ownership === "owned" &&
                  "Only documents where you are the owner."}
                {options.ownership === "shared-with-me" &&
                  "Only documents that were explicitly shared with you."}
              </p>
            </div>

            {/* Include shared drives */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="load-shared-drives"
                checked={options.includeSharedDrives}
                onCheckedChange={(checked) =>
                  setOptions((o) => ({
                    ...o,
                    includeSharedDrives: checked === true,
                  }))
                }
              />
              <label
                htmlFor="load-shared-drives"
                className="text-sm text-zinc-700 cursor-pointer"
              >
                Include shared drives
              </label>
            </div>

            {/* Scan results - summary */}
            {scanResult && (
              <>
                <hr className="border-zinc-200" />

                <div className="flex flex-col gap-1 text-sm text-zinc-600">
                  <span>
                    Total documents found: {scanResult.total}
                  </span>
                  <span>
                    New documents: {scanResult.newDocs.length}
                  </span>
                </div>

                {scanResult.newDocs.length === 0 && (
                  <p className="text-sm italic text-zinc-400">
                    No new documents found.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Doc list - flexible, shrinks first */}
          {scanResult && scanResult.newDocs.length > 0 && (
            <div
              className="mx-6 overflow-y-auto overflow-x-hidden rounded-md border border-zinc-200 bg-zinc-50/50 shrink"
              style={{
                minHeight: `calc(5 * 1.5rem + 2px)`,
                maxHeight: `calc(15 * 1.5rem + 2px)`,
              }}
            >
              {selectedDocs.length === 0 ? (
                <div className="py-4 text-center text-xs italic text-zinc-400">
                  All documents removed
                </div>
              ) : (
                <div className="flex flex-col">
                  {selectedDocs.map((doc) => (
                    <div
                      key={doc.googleDocId}
                      className="flex h-6 min-w-max items-center gap-2 px-2 transition-colors hover:bg-zinc-100"
                    >
                      <button
                        onClick={() =>
                          setSelectedDocs((prev) =>
                            prev.filter(
                              (d) =>
                                d.googleDocId !== doc.googleDocId
                            )
                          )
                        }
                        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
                        title="Remove from list"
                        aria-label={`Remove ${doc.title}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <a
                        href={doc.driveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 transition-colors hover:text-blue-600 hover:underline"
                        title={doc.title}
                      >
                        <DocTypeIcon
                          mimeType={doc.mimeType}
                          className="h-3 w-3 flex-shrink-0"
                        />
                        <span className="whitespace-nowrap pr-4 text-xs font-medium">
                          {doc.title}
                        </span>
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Below doc list - fixed */}
          {scanResult && scanResult.newDocs.length > 0 && (
            <div className="flex flex-col gap-4 px-6 py-4 shrink-0">
              {docsRemoved && (
                <p className="text-sm text-zinc-500">
                  {selectedDocs.length} document
                  {selectedDocs.length === 1 ? "" : "s"} selected
                </p>
              )}

              <LabelPicker
                selectedLabelIds={selectedLabelIds}
                onToggle={toggleLabel}
              />

              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
                  Notes
                </label>
                <textarea
                  ref={notesRef}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add notes..."
                  rows={1}
                  className={`${TEXTAREA_CLASSES} w-full max-h-[200px]`}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 flex gap-2 justify-end">
          {scanResult && scanResult.newDocs.length > 0 ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedDocs.length === 0 || adding}
                onClick={handleAdd}
                title="Add selected documents to your list"
              >
                {adding && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={scanning || adding}
                onClick={handleScan}
                title="Search again with current options"
              >
                {scanning && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Rescan
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                title="Cancel and close"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={scanning}
                onClick={handleScan}
                title="Search Google Drive for documents"
              >
                {scanning && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Scan
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancel}
                title="Cancel and close"
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

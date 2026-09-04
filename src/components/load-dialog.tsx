"use client";

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import {
  fetchWithProgress,
  handleRefreshProgress,
  formatResultParts,
  dismissProgressToasts,
} from "@/lib/stream-progress";
import { X, Loader2 } from "lucide-react";
import { AccessState, DocRole, DocStatus } from "@prisma/client";
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
import { useMultiSelect } from "@/hooks/use-multi-select";
import { StarButton } from "@/components/star-button";
import { docTarget } from "@/lib/tab-targets";
import { pluralize } from "@/lib/utils";

type TimeUnit = "days" | "months" | "years" | "all";

interface LoadOptions {
  daysBack: number | null;
  ownership: "all" | "owned" | "shared-with-me";
  includeSharedDrives: boolean;
}

interface ScanDoc {
  googleDocId: string;
  title: string;
  mimeType: string;
  driveUrl: string;
  role: DocRole;
  isNew: boolean;
  accessState?: typeof AccessState.NOT_FOUND | typeof AccessState.DENIED;
  notes?: string;
  emailDate?: string;
}

interface ScanResult {
  total: number;
  existingCount: number;
  errorCount?: number;
  docs: ScanDoc[];
  noGmailAccount?: boolean;
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
  const [removedDocIds, setRemovedDocIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"new" | "all">("new");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [isStarred, setIsStarred] = useState(false);
  const [addToInbox, setAddAsActive] = useState(true);
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<"drive" | "gmail">("drive");
  const [timeAmount, setTimeAmount] = useState("30");
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("days");
  const [docListRows, setDocListRows] = useState(5);

  function computeDaysBack(amount: string, unit: TimeUnit): number | null {
    if (unit === "all") return null;
    const n = parseInt(amount, 10);
    if (isNaN(n) || n < 1) return options.daysBack;
    const multiplier = unit === "years" ? 365 : unit === "months" ? 30 : 1;
    return n * multiplier;
  }

  const abortRef = useRef<AbortController | null>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useAutoResize(notesRef, notes);
  useLabelSync(allLabels, setSelectedLabelIds);

  const visibleDocs = scanResult
    ? scanResult.docs.filter(
        (d) =>
          !removedDocIds.has(d.googleDocId) &&
          (viewMode === "all" || d.isNew)
      )
    : [];

  const {
    highlightedIds, effectiveItems: effectiveDocs, handleRowClick,
    removeFromHighlight, clearHighlights, reset: resetHighlights, rowClassName,
  } = useMultiSelect(visibleDocs, d => d.googleDocId);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    if (isOpen) {
      setScanResult(null);
      setRemovedDocIds(new Set());
      setViewMode("new");
      setSource("drive");
      setSelectedLabelIds([]);
      setNotes("");
      setIsStarred(false);
      setAddAsActive(true);
      setTimeAmount("30");
      setTimeUnit("days");
      resetHighlights();
    } else {
      abortRef.current?.abort();
    }
    setOpen(isOpen);
  }, [resetHighlights]);

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
    const contextId = generateContextId();
    const sourceLabel = source === "gmail" ? "Gmail" : "Drive";
    try {
      const scanBody = source === "gmail"
        ? { source: "gmail", daysBack: options.daysBack }
        : { source: "drive", ...options };
      const result = await fetchWithProgress<ScanResult>("/api/docs/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scanBody),
        signal: controller.signal,
        contextId,
      }, handleRefreshProgress);

      setScanResult(result);
      setRemovedDocIds(new Set());
      resetHighlights();
      setDocListRows(Math.min(15, Math.max(5, result.docs.filter((d) => viewMode === "all" || d.isNew).length)));
      const newCount = result.docs.filter(d => d.isNew).length;
      dismissProgressToasts();
      if (result.noGmailAccount) {
        toast.warning("No Gmail account", { duration: 4000 });
      } else {
        toast.success(`Found ${pluralize(result.total, "document")} in ${sourceLabel} (${newCount} new)`, { duration: 4000 });
      }
    } catch (err) {
      dismissProgressToasts();
      if (err instanceof Error && err.name === "AbortError") return;
      if (!isAuthError(err)) toast.error(`Failed to scan ${source === "gmail" ? "Gmail" : "Google Drive"}`);
    } finally {
      setScanning(false);
    }
  }

  async function handleAdd() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAdding(true);
    const contextId = generateContextId();
    try {
      const docNotes: Record<string, string> = {};
      effectiveDocs.forEach(d => {
        // Only collect notes for accessible docs; inaccessible ones pass notes via inaccessibleDocs below.
        if (d.notes && !d.accessState) {
          docNotes[d.googleDocId] = d.notes;
        }
      });

      const data = await fetchWithProgress<Record<string, number>>("/api/docs?mode=load", {
        method: "POST",
        contextId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...options,
          source,
          selectedGoogleDocIds: effectiveDocs.map((d) => d.googleDocId),
          inaccessibleDocs: effectiveDocs
            .filter((d) => d.accessState)
            .map((d) => ({ googleDocId: d.googleDocId, title: d.title, accessState: d.accessState, notes: d.notes, emailDate: d.emailDate })),
          labelIds: selectedLabelIds,
          notes,
          docNotes,
          ...(isStarred ? { isStarred } : {}),
          status: addToInbox ? DocStatus.INBOX : DocStatus.ARCHIVED,
        }),
        signal: controller.signal,
      }, handleRefreshProgress);

      const docsRes = await apiFetch("/api/docs?includeArchived=true", {
        signal: controller.signal,
        contextId,
      });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const docs: DocWithLabels[] = await docsRes.json();

      onRefresh(docs);
      broadcastChange({ type: "docs" }, contextId);
      setOpen(false);

      dismissProgressToasts();
      const { summary } = formatResultParts(data);
      toast.success(`Load complete — ${summary}`, { duration: 8000 });
    } catch (err) {
      dismissProgressToasts();
      if (err instanceof Error && err.name === "AbortError") return;
      if (!isAuthError(err)) toast.error("Failed to sync with Google Drive");
    } finally {
      setAdding(false);
    }
  }

  function handleRemoveDoc(googleDocId: string) {
    setRemovedDocIds(prev => {
      const next = new Set(prev);
      next.add(googleDocId);
      return next;
    });
    removeFromHighlight(googleDocId);
  }

  function handleRemoveHighlighted() {
    const removed = clearHighlights();
    setRemovedDocIds(prev => {
      const next = new Set(prev);
      removed.forEach(id => next.add(id));
      return next;
    });
  }

  const hasAnyDocs = scanResult ? scanResult.docs.length > 0 : false;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={adding}
          title="Scan Drive or Gmail for documents to add"
        >
          Load docs
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Load from Drive or Gmail</DialogTitle>
          <DialogDescription>
            Discover documents from Google Drive or Gmail and sync their comments.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          <div className="flex flex-col gap-4 px-6 py-4 shrink-0">
            {/* Source toggle */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-700">
                Source
              </label>
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    if (source !== "drive") {
                      setSource("drive");
                      setScanResult(null);
                      setRemovedDocIds(new Set());
                    }
                  }}
                  title="Find Google Drive documents updated in the last N days"
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    source === "drive"
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  }`}
                >
                  Drive
                </button>
                <button
                  onClick={() => {
                    if (source !== "gmail") {
                      setSource("gmail");
                      setScanResult(null);
                      setRemovedDocIds(new Set());
                    }
                  }}
                  title="Find documents from Gmail notifications in the last N days"
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    source === "gmail"
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  }`}
                >
                  Gmail
                </button>
              </div>
            </div>

            {/* Days back */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="load-days-back"
                className="text-sm font-medium text-zinc-700"
              >
                Time window
              </label>
              <div className="flex items-center gap-2">
                {timeUnit !== "all" && (
                  <input
                    id="load-days-back"
                    type="number"
                    min={1}
                    value={timeAmount}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => {
                      setTimeAmount(e.target.value);
                      setOptions((o) => ({ ...o, daysBack: computeDaysBack(e.target.value, timeUnit) }));
                    }}
                    onBlur={() => {
                      const v = parseInt(timeAmount, 10);
                      if (isNaN(v) || v < 1) {
                        setTimeAmount("30");
                        setOptions((o) => ({ ...o, daysBack: computeDaysBack("30", timeUnit) }));
                      }
                    }}
                    className="w-20 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                )}
                <select
                  value={timeUnit}
                  onChange={(e) => {
                    const unit = e.target.value as TimeUnit;
                    setTimeUnit(unit);
                    if (unit === "months" || unit === "years") {
                      setTimeAmount("1");
                      setOptions((o) => ({ ...o, daysBack: computeDaysBack("1", unit) }));
                    } else {
                      setOptions((o) => ({ ...o, daysBack: computeDaysBack(timeAmount, unit) }));
                    }
                  }}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <option value="days">days back</option>
                  <option value="months">months back</option>
                  <option value="years">years back</option>
                  <option value="all">all time</option>
                </select>
              </div>
            </div>

            {/* Ownership filter — Drive only */}
            {source === "drive" && (
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
            )}

            {/* Include shared drives — Drive only */}
            {source === "drive" && (
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
                  className="text-sm text-zinc-700 "
                >
                  Include shared drives
                </label>
              </div>
            )}

            {/* Scan results - summary */}
            {scanResult && (
              <>
                <hr className="border-zinc-200" />

                <div className="flex flex-col gap-1 text-sm text-zinc-600">
                  <span>
                    Total documents found: {scanResult.total}
                  </span>
                  <span>
                    New documents: {scanResult.docs.filter((d) => d.isNew).length}
                  </span>
                  {(scanResult.errorCount ?? 0) > 0 && (
                    <span className="text-amber-600">
                      {scanResult.errorCount} email{scanResult.errorCount === 1 ? "" : "s"} could not be resolved
                    </span>
                  )}
                </div>

                {/* New / All toggle */}
                {hasAnyDocs && (
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setViewMode("new");
                        setDocListRows(Math.min(15, Math.max(5, scanResult.docs.filter((d) => d.isNew && !removedDocIds.has(d.googleDocId)).length)));
                      }}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        viewMode === "new"
                          ? "bg-zinc-900 text-white"
                          : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                      }`}
                    >
                      New
                    </button>
                    <button
                      onClick={() => {
                        setViewMode("all");
                        setDocListRows(Math.min(15, Math.max(5, scanResult.docs.filter((d) => !removedDocIds.has(d.googleDocId)).length)));
                      }}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        viewMode === "all"
                          ? "bg-zinc-900 text-white"
                          : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                      }`}
                    >
                      All
                    </button>
                  </div>
                )}

                {!hasAnyDocs && (
                  <p className="text-sm italic text-zinc-400">
                    No new documents found.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Doc list - flexible, shrinks first; height based on view's doc count (ignoring removals) so X-clicks don't resize */}
          {scanResult && hasAnyDocs && (
            <div
              tabIndex={-1}
              onKeyDown={(e) => {
                if ((e.key === "Delete" || e.key === "Backspace") && highlightedIds.size > 0) {
                  e.preventDefault();
                  handleRemoveHighlighted();
                }
              }}
              className="mx-6 overflow-y-auto overflow-x-hidden rounded-md border border-zinc-200 bg-zinc-50/50 shrink outline-none"
              style={{
                height: `calc(${docListRows} * 1.5rem + 2px)`,
                minHeight: `calc(5 * 1.5rem + 2px)`,
                maxHeight: `calc(15 * 1.5rem + 2px)`,
              }}
            >
              {visibleDocs.length === 0 ? (
                <div className="py-4 text-center text-xs italic text-zinc-400">
                  {viewMode === "new"
                    ? "No new documents — switch to All to see existing docs"
                    : "All documents removed"}
                </div>
              ) : (
                <div className="flex flex-col">
                  {visibleDocs.map((doc) => (
                    <div
                      key={doc.googleDocId}
                      onClick={(e) => handleRowClick(doc.googleDocId, e)}
                      className={rowClassName(doc.googleDocId, "flex h-6 min-w-max items-center gap-2 px-2 transition-colors")}
                    >
                      <button
                        onClick={() => handleRemoveDoc(doc.googleDocId)}
                        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
                        title="Remove from list"
                        aria-label={`Remove ${doc.title}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                      {viewMode === "all" && (
                        <span className={`w-7 text-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                          doc.isNew
                            ? "bg-emerald-100 text-emerald-700"
                            : ""
                        }`}>
                          {doc.isNew ? "NEW" : ""}
                        </span>
                      )}
                      <a
                        href={doc.driveUrl}
                        target={docTarget(doc.googleDocId)}
                        onClick={(e) => {
                          // Left-click selects the row; double-click opens
                          if (e.detail === 1) {
                            e.preventDefault();
                          }
                        }}
                        title="Click to select, middle- or double-click to open"
                        className="flex items-center gap-2"
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
          {scanResult && hasAnyDocs && (
            <div className="flex flex-col gap-4 px-6 py-4 shrink-0">
              <p className="text-sm text-zinc-400">
                {removedDocIds.size > 0 || highlightedIds.size > 0
                  ? `${effectiveDocs.length} document${effectiveDocs.length === 1 ? "" : "s"} selected`
                  : "Click to select, middle- or double-click to open"}
              </p>

              <LabelPicker
                selectedLabelIds={selectedLabelIds}
                onToggle={toggleLabel}
                prefix={<StarButton starred={isStarred} onToggle={() => setIsStarred(!isStarred)} />}
              />

              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-900 uppercase tracking-wide">
                  Notes
                </label>
                <textarea
                  ref={notesRef}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  placeholder="Add notes..."
                  rows={1}
                  className={`${TEXTAREA_CLASSES} w-full max-h-[200px]`}
                />
              </div>

              <div
                className="flex items-center gap-2"
                title={viewMode === "all"
                  ? "When checked, all loaded docs move to Inbox. When unchecked, new docs start as Archived and existing docs keep their current status."
                  : "When checked, new docs start in Inbox. When unchecked, new docs start as Archived."}
              >
                <Checkbox
                  id="load-to-inbox"
                  checked={addToInbox}
                  onCheckedChange={(checked) => setAddAsActive(checked === true)}
                />
                <label
                  htmlFor="load-to-inbox"
                  className="text-sm text-zinc-700 "
                >
                  {viewMode === "all" ? "Move to Inbox" : "Add to Inbox"}
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 flex gap-2 justify-end">
          {scanResult && hasAnyDocs ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={effectiveDocs.length === 0 || adding}
                onClick={handleAdd}
                title={viewMode === "all"
                  ? "Add new documents and update labels/notes on existing ones"
                  : "Add selected documents to your list"}
              >
                {adding && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                {viewMode === "all" ? "Add or Update" : "Add"}
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

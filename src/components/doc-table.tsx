"use client";

import { useState, useCallback, useEffect } from "react";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { useCrossTabListener, crossTabReason, broadcastChange, type CrossTabReceivedEvent } from "@/lib/cross-tab";
import type { TriState } from "@/lib/tri-state";
import { DocRow } from "@/components/doc-row";
import { FilterBar } from "@/components/filter-bar";
import { AddDocDialog } from "@/components/add-doc-dialog";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { RefreshButton } from "@/components/refresh-button";
import { LoadDialog } from "@/components/load-dialog";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { signOut } from "next-auth/react";
import { Menu, RefreshCw, LogOut, HardDriveDownload, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { filterDocs, sortDocs } from "@/lib/doc-filters";
import type { SortCol, SortDir } from "@/lib/doc-filters";
import { LabelProvider } from "@/contexts/label-context";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import { UNREAD_COMMENTS_TOOLTIP, INBOX_COMMENTS_TOOLTIP, OPEN_COMMENTS_TOOLTIP } from "@/lib/tooltips";

interface DocTableProps {
  initialDocs: DocWithLabels[];
  initialLabels: Label[];
  isOffline?: boolean;
}

export function DocTable({ initialDocs, initialLabels, isOffline }: DocTableProps) {
  const [docs, setDocs] = useState<DocWithLabels[]>(initialDocs);
  const [labels, setLabelsRaw] = useState<Label[]>(initialLabels);

  // When labels change (e.g. color update), propagate into docs state too
  function setLabels(newLabels: Label[]) {
    setLabelsRaw(newLabels);
    const labelMap = new Map(newLabels.map((l) => [l.labelId, l]));
    setDocs((prev) =>
      prev.map((doc) => ({
        ...doc,
        labels: doc.labels
          .map((dl) => ({
            ...dl,
            label: labelMap.get(dl.labelId) ?? dl.label,
          }))
          .sort((a, b) => (a.label?.position ?? 0) - (b.label?.position ?? 0)),
      }))
    );
  }

  // Any cross-tab mutation warrants a full refresh since DocTable shows aggregate data
  const refetchAll = useCallback(async (event?: CrossTabReceivedEvent) => {
    try {
      const contextId = generateContextId();
      const reason = event ? crossTabReason(event, "doc-list") : undefined;
      const [docsRes, labelsRes] = await Promise.all([
        apiFetch("/api/docs?includeArchived=true", { contextId, reason }),
        apiFetch("/api/labels", { contextId }),
      ]);
      if (docsRes.ok) setDocs(await docsRes.json());
      if (labelsRes.ok) setLabelsRaw(await labelsRes.json());
    } catch { /* cross-tab sync is best-effort */ }
  }, []);

  useCrossTabListener(refetchAll);

  const [isInbox, setIsInbox] = useState<TriState>("include");
  const [hasComments, setHasComments] = useState<TriState>("off");
  const [isAuthor, setIsAuthor] = useState<TriState>("off");
  const [mimeTypes, setMimeTypes] = useState<Record<string, TriState>>({});
  const [labelsFilter, setLabelsFilter] = useState<Record<string, TriState>>({});
  const [titleFilter, setTitleFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("lastModifiedInDrive");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Update document title to reflect active filters
  useEffect(() => {
    const MIME_NAMES: Record<string, string> = {
      "application/vnd.google-apps.document": "Docs",
      "application/vnd.google-apps.spreadsheet": "Sheets",
      "application/vnd.google-apps.presentation": "Slides",
    };
    const parts: string[] = [];

    for (const [mime, state] of Object.entries(mimeTypes)) {
      const name = MIME_NAMES[mime] ?? mime;
      if (state === "include") parts.push(name);
      else if (state === "exclude") parts.push(`!${name}`);
    }

    if (isAuthor === "include") parts.push("Author");
    else if (isAuthor === "exclude") parts.push("!Author");

    for (const label of labels) {
      const state = labelsFilter[label.labelId];
      if (state === "include") parts.push(label.name);
      else if (state === "exclude") parts.push(`!${label.name}`);
    }

    if (isInbox === "exclude") parts.push("!Inbox");
    else if (isInbox === "off") parts.push("All docs");

    if (hasComments === "include") parts.push("Comments");
    else if (hasComments === "exclude") parts.push("!Comments");

    if (titleFilter) {
      const truncated = titleFilter.length > 20
        ? titleFilter.slice(0, 20) + "..."
        : titleFilter;
      parts.push(`"${truncated}"`);
    }

    // Inbox "include" is the default view — only show it when it's the sole filter
    if (isInbox === "include" && parts.length === 0) parts.push("Inbox");

    document.title = "Docreview: " + parts.join(", ");
  }, [isInbox, hasComments, isAuthor, mimeTypes, labelsFilter, titleFilter, labels]);

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "lastModifiedInDrive" || col === "unread" || col === "inbox" || col === "open" ? "desc" : "asc");
    }
  }

  function handleTriStateChange(
    setter: React.Dispatch<React.SetStateAction<Record<string, TriState>>>,
    key: string,
    value: TriState
  ) {
    setter((prev) => {
      // Remove entry when cycling back to off to keep state clean
      if (value === "off") {
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: value };
    });
  }

  function handleDocUpdate(updated: DocWithLabels) {
    setDocs((prev) => prev.map((d) => (d.docId === updated.docId ? updated : d)));
  }

  function handleBulkUpdate(updatedDocs: DocWithLabels[]) {
    const updatedMap = new Map(updatedDocs.map((d) => [d.docId, d]));
    setDocs((prev) => prev.map((d) => updatedMap.get(d.docId) ?? d));
  }

  function handleDocAdded(newDoc: DocWithLabels) {
    setDocs((prev) => {
      const idx = prev.findIndex((d) => d.docId === newDoc.docId);
      if (idx >= 0) {
        // Update existing doc in place
        return prev.map((d) => (d.docId === newDoc.docId ? newDoc : d));
      }
      return [newDoc, ...prev];
    });
  }

  function handleLabelDelete(id: string) {
    setLabels(labels.filter((l) => l.labelId !== id));
    setDocs((prev) =>
      prev.map((d) => ({
        ...d,
        labels: d.labels.filter((dl) => dl.labelId !== id),
      }))
    );
    setLabelsFilter((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  }

  // Which refresh operation is active (null = idle). Only one can run at a time.
  const [refreshing, setRefreshing] = useState<"main" | "drive" | "gmail" | "full" | null>(null);

  async function handleFullRefresh() {
    setRefreshing("full");
    const contextId = generateContextId();
    try {
      const syncRes = await apiFetch("/api/docs?mode=full-refresh", { method: "POST", contextId });
      if (!syncRes.ok) throw new Error("Sync failed");
      const data = await syncRes.json();

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const newDocs: DocWithLabels[] = await docsRes.json();

      setDocs(newDocs);
      broadcastChange({ type: "docs" }, contextId);

      const parts = [
        data.added > 0 ? `${data.added} new` : "",
        data.updated > 0 ? `${data.updated} updated` : "",
        data.deleted > 0 ? `${data.deleted} deleted` : "",
        data.unarchived > 0 ? `${data.unarchived} unarchived` : "",
      ].filter(Boolean).join(", ");
      toast.success(`Full refresh complete — ${parts || "no updates"}`, { duration: 8000 });
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to sync with Google Drive");
    } finally {
      setRefreshing(null);
    }
  }

  async function handleSourceRefresh(sources: ("drive" | "gmail")[]) {
    setRefreshing(sources.length === 1 ? sources[0] : "main");
    const contextId = generateContextId();
    try {
      const syncRes = await apiFetch("/api/docs/refresh", {
        method: "POST",
        contextId,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources }),
      });
      if (!syncRes.ok) throw new Error("Refresh failed");
      const data = await syncRes.json();

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const newDocs: DocWithLabels[] = await docsRes.json();

      setDocs(newDocs);
      broadcastChange({ type: "docs" }, contextId);

      const label = sources.length === 1
        ? sources[0] === "drive" ? "Drive refresh" : "Gmail refresh"
        : "Refresh";
      const parts = [
        data.added > 0 ? `${data.added} new` : "",
        data.updated > 0 ? `${data.updated} updated` : "",
        data.deleted > 0 ? `${data.deleted} deleted` : "",
        data.unarchived > 0 ? `${data.unarchived} unarchived` : "",
      ].filter(Boolean).join(", ");
      const errorSuffix = data.errorCount > 0 ? ` (${data.errorCount} errors)` : "";
      toast.success(`${label} complete — ${parts || "no updates"}${errorSuffix}`, { duration: 8000 });
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to refresh");
    } finally {
      setRefreshing(null);
    }
  }

  const filteredDocs = sortDocs(
    filterDocs(docs, {
      isInbox,
      hasComments,
      isAuthor,
      mimeTypes,
      labels: labelsFilter,
      titleFilter,
    }),
    sortCol,
    sortDir
  );

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="text-zinc-300">↕</span>;
    return <span>{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, rowSpan, title, className, children }: { col: SortCol; rowSpan?: number; title?: string; className?: string; children: React.ReactNode }) {
    return (
      <th className={className || "px-2 py-2.5 text-left"} rowSpan={rowSpan}>
        <button
          onClick={() => handleSort(col)}
          title={title}
          className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
        >
          {children}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  return (
    <LabelProvider allLabels={labels} onLabelsChange={setLabels} onLabelDelete={handleLabelDelete}>
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Docreview: Inbox view</h1>
        <div className="flex items-center gap-2">
          <RefreshButton
            onRefresh={(newDocs) => setDocs(newDocs)}
            disabled={refreshing !== null}
            onLoadingChange={(v) => setRefreshing(v ? "main" : null)}
          />
          <AddDocDialog
            onDocAdded={handleDocAdded}
            trigger={
              <Button variant="outline" size="sm" title="Add a Google Drive document by URL or doc ID">
                Add doc
              </Button>
            }
          />
          <LoadDialog onRefresh={(newDocs) => setDocs(newDocs)} />
          <ManageLabelsDialog />
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open("https://drive.google.com", "_blank")}
            title="Open Google Drive"
          >
            <img
              src="https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png"
              alt="Google Drive"
              className="h-4 w-4 mr-1.5"
            />
            Drive
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                title="More options"
                className="px-2"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => handleSourceRefresh(["drive"])}
                disabled={refreshing !== null}
              >
                {refreshing === "drive" ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <HardDriveDownload className="h-4 w-4 mr-2" />}
                Refresh from Drive
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => handleSourceRefresh(["gmail"])}
                disabled={refreshing !== null}
              >
                {refreshing === "gmail" ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
                Refresh from Gmail
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleFullRefresh}
                disabled={refreshing !== null}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${refreshing === "full" ? "animate-spin" : ""}`} />
                Full Refresh
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => window.open("/add", "_blank")}
              >
                <span className="h-4 w-4 mr-2" />
                Add doc page
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => signOut({ callbackUrl: "/login" })}
                disabled={isOffline}
              >
                <LogOut className="h-4 w-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FilterBar
        labels={labels}
        isInbox={isInbox}
        hasComments={hasComments}
        isAuthor={isAuthor}
        mimeTypes={mimeTypes}
        labelsFilter={labelsFilter}
        titleFilter={titleFilter}
        onIsInboxChange={setIsInbox}
        onHasCommentsChange={setHasComments}
        onIsAuthorChange={setIsAuthor}
        onMimeTypeChange={(mt, v) => handleTriStateChange(setMimeTypes, mt, v)}
        onLabelChange={(id, v) => handleTriStateChange(setLabelsFilter, id, v)}
        onTitleFilterChange={setTitleFilter}
      />

      {filteredDocs.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {docs.length === 0
            ? 'No docs yet. Use "Refresh", "Add doc", or "Load docs" to add some.'
            : "No docs match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <ThButton col="title" title="Document title">Title</ThButton>
                <th colSpan={3} className="px-1 py-1.5">
                  <div className="text-center text-xs font-medium text-zinc-500 uppercase tracking-wide leading-none mb-1">Comments</div>
                  <div className="flex gap-2">
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("unread")} title={UNREAD_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Unread<SortIcon col="unread" /></button></div>
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("inbox")} title={INBOX_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Inbox<SortIcon col="inbox" /></button></div>
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("open")} title={OPEN_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Open<SortIcon col="open" /></button></div>
                  </div>
                </th>
                <ThButton col="lastModifiedInDrive" title="Last change time">Last Modified</ThButton>
                <th className="px-4 py-2 text-left">
                  <div className="flex items-center gap-2">
                    <BulkEditDialog
                      initialDocs={filteredDocs}
                      onSave={handleBulkUpdate}
                    >
                      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Edit all currently displayed documents">
                        Edit All
                      </Button>
                    </BulkEditDialog>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filteredDocs.map((doc) => (
                <DocRow
                  key={doc.docId}
                  doc={doc}
                  onUpdate={handleDocUpdate}
                  searchFilter={titleFilter}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </LabelProvider>
  );
}

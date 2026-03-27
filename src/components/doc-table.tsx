"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { Label } from "@prisma/client";
import type { DocWithLabels } from "@/types";
import { useCrossTabListener, crossTabReason, broadcastChange, type CrossTabReceivedEvent } from "@/lib/cross-tab";
import { pingExtension } from "@/lib/bridge-to-extension";
import type { TriState } from "@/lib/tri-state";
import { DocRow } from "@/components/doc-row";
import { FilterBar } from "@/components/filter-bar";
import { AddDocDialog } from "@/components/add-doc-dialog";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { RefreshButton } from "@/components/refresh-button";
import { LoadDialog } from "@/components/load-dialog";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { signOut } from "next-auth/react";
import { Menu, RefreshCw, LogOut, HardDriveDownload, Mail, FileText, CircleHelp, Trash2 } from "lucide-react";
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
import { useCachedMetadata } from "@/hooks/use-cached-metadata";
import { LabelProvider } from "@/contexts/label-context";
import { HelpDialog } from "@/components/help-dialog";
import { DeleteAllDialog } from "@/components/delete-all-dialog";
import { clearAll as clearBrowserCache } from "@/lib/browser-cache";
import { CHROME_EXTENSION_URL } from "@/lib/env-config";
import { WelcomeDialog } from "@/components/welcome-dialog";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import {
  fetchWithProgress,
  handleRefreshProgress,
  formatResultParts,
  dismissProgressToasts,
} from "@/lib/stream-progress";
import { UNREAD_COMMENTS_TOOLTIP, INBOX_COMMENTS_TOOLTIP, OPEN_COMMENTS_TOOLTIP } from "@/lib/tooltips";

interface DocTableProps {
  initialDocs: DocWithLabels[];
  initialLabels: Label[];
  isOffline?: boolean;
  userId: string;
  hasSeenHelp?: boolean;
}

export function DocTable({ initialDocs, initialLabels, isOffline, userId, hasSeenHelp }: DocTableProps) {
  const [docs, setDocs] = useState<DocWithLabels[]>(initialDocs);
  const [labels, setLabelsRaw] = useState<Label[]>(initialLabels);
  const { titles: cachedTitles } = useCachedMetadata(userId, docs);
  const [showHelp, setShowHelp] = useState(false);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [showWelcome, setShowWelcome] = useState(hasSeenHelp === false);

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
    if (event?.type === "signout") {
      signOut({ callbackUrl: "/login" });
      return;
    }
    try {
      if (event) console.log("[cross-tab] doc-list: refreshing", `(${event.type} event)`); // eslint-disable-line no-console
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
  const [isStarred, setIsStarred] = useState<TriState>("off");
  const [mimeTypes, setMimeTypes] = useState<Record<string, TriState>>({});
  const [labelsFilter, setLabelsFilter] = useState<Record<string, TriState>>({});
  const [titleFilter, setTitleFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("lastCommentActivity");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Compute page title from active filters
  const pageTitle = useMemo(() => {
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

    if (isStarred === "include") parts.push("Starred");
    else if (isStarred === "exclude") parts.push("!Starred");

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

    return ("Docreview: " + parts.join(", ")).replace(/\s+/g, " ").trim();
  }, [isInbox, hasComments, isAuthor, isStarred, mimeTypes, labelsFilter, titleFilter, labels]);

  // Ping extension on mount so focusDocTab() has cached status for doc-row
  useEffect(() => { void pingExtension(); }, []);

  // Next.js metadata reconciliation can reset document.title after effects run.
  // Use a MutationObserver to detect and override any external title changes.
  useEffect(() => {
    if (document.title !== pageTitle) document.title = pageTitle;
    const titleEl = document.querySelector("title");
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      if (document.title !== pageTitle) document.title = pageTitle;
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [pageTitle]);

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "lastCommentActivity" || col === "unread" || col === "inbox" || col === "open" ? "desc" : "asc");
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
  const [refreshing, setRefreshing] = useState<"main" | "drive" | "gmail" | "full" | "selected" | null>(null);

  async function runRefresh(
    spinnerKey: "main" | "drive" | "gmail" | "full" | "selected",
    url: string,
    fetchOpts: Record<string, unknown>,
    successLabel: string,
    errorLabel: string,
  ) {
    setRefreshing(spinnerKey);
    const contextId = generateContextId();
    try {
      let fetchSeq = 0; // Guards against out-of-order doc fetches
      const data = await fetchWithProgress<Record<string, number>>(url, {
        method: "POST",
        contextId,
        ...fetchOpts,
      }, (event) => {
        if (event.phase === "docs-updated") {
          // Refresh the docs list early, before comment sync finishes
          const seq = ++fetchSeq;
          apiFetch("/api/docs?includeArchived=true", { contextId }).then(async (res) => {
            if (res.ok && seq === fetchSeq) setDocs(await res.json());
          }).catch(() => {});
          return;
        }
        handleRefreshProgress(event);
      });

      const docsRes = await apiFetch("/api/docs?includeArchived=true", { contextId });
      if (!docsRes.ok) throw new Error("Failed to reload docs");
      const newDocs: DocWithLabels[] = await docsRes.json();
      fetchSeq++; // Invalidate any in-flight early fetch

      setDocs(newDocs);
      broadcastChange({ type: "docs" }, contextId);

      dismissProgressToasts();
      const { summary, errorSuffix } = formatResultParts(data);
      toast.success(`${successLabel} — ${summary}${errorSuffix}`, { duration: 8000 });
    } catch (err) {
      dismissProgressToasts();
      if (!isAuthError(err)) toast.error(errorLabel);
    } finally {
      setRefreshing(null);
    }
  }

  async function handleRefreshSelected() {
    if (filteredDocs.length === 0) return;
    const docIds = filteredDocs.map((d) => d.docId);
    await runRefresh("selected", "/api/docs/refresh-selected", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docIds }),
    }, "Refresh complete", "Failed to refresh selected docs");
  }

  async function handleFullRefresh() {
    await runRefresh("full", "/api/docs?mode=full-refresh", {},
      "Full refresh complete", "Failed to sync with Google Drive");
  }

  async function handleSourceRefresh(sources: ("drive" | "gmail")[]) {
    const label = sources.length === 1
      ? sources[0] === "drive" ? "Drive refresh" : "Gmail refresh"
      : "Refresh";
    await runRefresh(
      sources.length === 1 ? sources[0] : "main",
      "/api/docs/refresh",
      { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources }) },
      `${label} complete`, "Failed to refresh",
    );
  }

  const filteredDocs = sortDocs(
    filterDocs(docs, {
      isInbox,
      hasComments,
      isAuthor,
      isStarred,
      mimeTypes,
      labels: labelsFilter,
      titleFilter,
      titles: cachedTitles,
    }),
    sortCol,
    sortDir,
    cachedTitles
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
        <div className="flex items-center gap-3">
          <img src="/docreview.svg" alt="Docreview Logo" className="h-8 w-8 rounded-lg shadow-sm" />
          <h1 className="text-xl font-semibold text-zinc-900 tracking-tight">Docreview: Inbox view</h1>
        </div>
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
          <HelpDialog open={showHelp} onOpenChange={setShowHelp} />
          <DeleteAllDialog open={showDeleteAll} onOpenChange={setShowDeleteAll} />
          <WelcomeDialog open={showWelcome} onOpenChange={setShowWelcome} />
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
                onSelect={() => setShowHelp(true)}
                title="Open the help guide"
              >
                <CircleHelp className="h-4 w-4 mr-2" />
                Help
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => handleSourceRefresh(["drive"])}
                disabled={refreshing !== null}
                title="Scan Google Drive for recent document changes"
              >
                {refreshing === "drive" ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <HardDriveDownload className="h-4 w-4 mr-2" />}
                Refresh from Drive
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => handleSourceRefresh(["gmail"])}
                disabled={refreshing !== null}
                title="Scan Gmail for new document notifications"
              >
                {refreshing === "gmail" ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
                Refresh from Gmail
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleRefreshSelected}
                disabled={refreshing !== null || filteredDocs.length === 0}
                title="Refresh metadata and comments for currently displayed documents"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${refreshing === "selected" ? "animate-spin" : ""}`} />
                Refresh selected
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={handleFullRefresh}
                disabled={refreshing !== null}
                title="Refresh metadata and comments for all documents in the database"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${refreshing === "full" ? "animate-spin" : ""}`} />
                Full refresh
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => window.open("/add", "_blank")}
                title="Open the standalone document import page"
              >
                <FileText className="h-4 w-4 mr-2" />
                Add doc page
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => window.open(CHROME_EXTENSION_URL, "_blank")}
                title="Info and installation instructions for the Chrome extension"
              >
                <FileText className="h-4 w-4 mr-2" />
                Chrome extension
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  const { removed, found, error } = clearBrowserCache();
                  if (error) {
                    toast.error(`Cache clear failed: ${error} (${removed}/${found} removed)`);
                  } else if (removed < found) {
                    toast.error(`Cleared ${removed} of ${found} cached items`);
                  } else {
                    toast.success(`Cleared ${removed} cached ${removed === 1 ? "item" : "items"}`);
                  }
                }}
                title="Delete all data cached in local browser storage"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear cache
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setShowDeleteAll(true)}
                disabled={isOffline}
                title="Delete all your data from Docreview's database"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete all data
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  broadcastChange({ type: "signout" });
                  signOut({ callbackUrl: "/login" });
                }}
                disabled={isOffline}
                title="Sign out of your account"
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
        isStarred={isStarred}
        mimeTypes={mimeTypes}
        labelsFilter={labelsFilter}
        titleFilter={titleFilter}
        onIsInboxChange={setIsInbox}
        onHasCommentsChange={setHasComments}
        onIsAuthorChange={setIsAuthor}
        onIsStarredChange={setIsStarred}
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
                <th className="w-0" />
                <ThButton col="title" title="Document title">Title</ThButton>
                <th colSpan={3} className="px-1 py-1.5">
                  <div className="text-center text-xs font-medium text-zinc-500 uppercase tracking-wide leading-none mb-1">Comments</div>
                  <div className="flex gap-2">
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("unread")} title={UNREAD_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Unread<SortIcon col="unread" /></button></div>
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("inbox")} title={INBOX_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Inbox<SortIcon col="inbox" /></button></div>
                    <div className="flex-1 flex justify-center"><button onClick={() => handleSort("open")} title={OPEN_COMMENTS_TOOLTIP} className="inline-flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800">Open<SortIcon col="open" /></button></div>
                  </div>
                </th>
                <ThButton col="lastCommentActivity" title="Time of latest comment activity">Last Change</ThButton>
                <th className="px-4 py-2 text-left">
                  <div className="flex items-center gap-2">
                    <BulkEditDialog
                      initialDocs={filteredDocs}
                      cachedTitles={cachedTitles}
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
                  cachedTitle={cachedTitles[doc.googleDocId]}
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

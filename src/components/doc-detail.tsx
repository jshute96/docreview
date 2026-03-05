"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { RefreshCw, Menu, Archive, ArchiveRestore } from "lucide-react";
import type { Comment, Label } from "@prisma/client";
import type { DocWithComments, DocWithLabels } from "@/types";
import type { CommentThread, SuggestionContent } from "@/lib/google-drive";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { LabelBadge } from "@/components/label-badge";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { ROLE_COLORS } from "@/lib/role-colors";
import { CommentFilterBar } from "@/components/comment-filter-bar";
import { CommentRow } from "@/components/comment-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FriendlyDate } from "@/components/friendly-date";
import { createMatcher } from "@/lib/highlight";
import { broadcastChange, useCrossTabListener, crossTabReason, type CrossTabReceivedEvent } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import { LabelProvider } from "@/contexts/label-context";

interface DocDetailProps {
  doc: DocWithComments;
  allLabels: Label[];
}

export function DocDetail({ doc: initialDoc, allLabels: initialLabels }: DocDetailProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [labels, setLabelsRaw] = useState<Label[]>(initialLabels);

  function setLabels(newLabels: Label[]) {
    setLabelsRaw(newLabels);
    const labelMap = new Map(newLabels.map((l) => [l.labelId, l]));
    setDoc((prev) => ({
      ...prev,
      labels: prev.labels
        .map((dl) => ({
          ...dl,
          label: labelMap.get(dl.labelId) ?? dl.label,
        }))
        .sort((a, b) => (a.label?.position ?? 0) - (b.label?.position ?? 0)),
    }));
  }

  function handleLabelDelete(id: string) {
    setLabels(labels.filter((l) => l.labelId !== id));
    setDoc((prev) => ({
      ...prev,
      labels: prev.labels.filter((dl) => dl.labelId !== id),
    }));
  }

  const [comments, setComments] = useState<Comment[]>(initialDoc.comments);
  const [archiving, setArchiving] = useState(false);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [bulkUnarchiving, setBulkUnarchiving] = useState(false);
  const [threadMap, setThreadMap] = useState<Record<string, CommentThread>>({});
  const [suggestionContent, setSuggestionContent] = useState<Record<string, SuggestionContent>>({});
  const [documentText, setDocumentText] = useState<string | undefined>(undefined);

  // Derive searchable text from threadMap (author names + all reply content)
  const threadText = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [id, thread] of Object.entries(threadMap)) {
      const parts: string[] = [thread.author, thread.content];
      for (const r of thread.replies) {
        if (r.author) parts.push(r.author);
        if (r.content) parts.push(r.content);
      }
      result[id] = parts.join("\n");
    }
    return result;
  }, [threadMap]);

  // Derive preview content ("Author: text") from threadMap
  const commentContent = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [id, thread] of Object.entries(threadMap)) {
      result[id] = thread.author ? `${thread.author}: ${thread.content}` : thread.content;
    }
    return result;
  }, [threadMap]);

  const handleThreadUpdate = useCallback((googleCommentId: string, thread: CommentThread) => {
    setThreadMap((prev) => ({ ...prev, [googleCommentId]: thread }));
  }, []);

  async function fetchThreads(contextId?: string) {
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/comments`, { contextId });
      if (res.ok) {
        const data = await res.json();
        setThreadMap(data.threads ?? {});
      }
    } catch { /* threads are optional */ }
  }

  async function fetchDocContent(contextId?: string) {
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/content`, { contextId });
      if (res.ok) {
        const data = await res.json();
        setSuggestionContent(data.suggestions ?? {});
        if (data.documentText !== undefined) setDocumentText(data.documentText);
      }
    } catch { /* content is optional */ }
  }

  function fetchContent(contextId?: string) {
    void fetchThreads(contextId);
    void fetchDocContent(contextId);
  }

  useEffect(() => { void fetchContent(generateContextId()); }, [doc.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [notFound, setNotFound] = useState(false);
  const handleCrossTab = useCallback(async (event: CrossTabReceivedEvent) => {
    try {
      const contextId = generateContextId();
      const reason = crossTabReason(event, "doc-detail");
      const refetchDoc = async () => {
        const docRes = await apiFetch(`/api/docs/${initialDoc.docId}`, { contextId, reason });
        if (docRes.ok) {
          const updated: DocWithComments = await docRes.json();
          setDoc(updated);
          setComments(updated.comments);
          setSortActive(true);
        } else if (docRes.status === 404 || docRes.status === 410) {
          setNotFound(true);
        }
      };

      if (event.type === "docs") {
        // Skip if the event is for a different doc
        if (event.docId && event.docId !== initialDoc.docId) return;
        const [labelsRes] = await Promise.all([
          apiFetch("/api/labels", { contextId }),
          refetchDoc(),
        ]);
        if (labelsRes.ok) setLabelsRaw(await labelsRes.json());
      } else if (event.type === "labels") {
        const [labelsRes] = await Promise.all([
          apiFetch("/api/labels", { contextId }),
          refetchDoc(),
        ]);
        if (labelsRes.ok) setLabelsRaw(await labelsRes.json());
      } else if (event.type === "comments" && event.docId === initialDoc.docId) {
        await refetchDoc();
        void fetchContent(contextId);
      }
    } catch { /* cross-tab sync is best-effort */ }
  }, [initialDoc.docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useCrossTabListener(handleCrossTab);

  const [myThreadsFilter, setMyThreadsFilter] = useState(false);
  const [myCommentsFilter, setMyCommentsFilter] = useState(false);
  const [showMode, setShowMode] = useState<"inbox" | "open" | "resolved" | "all">("inbox");
  const [suggestionsOnly, setSuggestionsOnly] = useState(false);
  const [unrepliedFilter, setUnrepliedFilter] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  type SortCol = "driveCreatedAt" | "driveModifiedAt" | "replyCount" | "iParticipated" | "resolved";
  type SortDir = "asc" | "desc";
  const [sortCol, setSortCol] = useState<SortCol>("driveModifiedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // When a single comment is updated (reply, resolve, refresh), we freeze the
  // table order so it doesn't jump around. Sort icons go unselected to signal
  // the order may be stale. Clicking a column header or the global Refresh
  // reactivates sorting.
  const [sortActive, setSortActive] = useState(true);
  const frozenOrderRef = useRef<Map<string, number>>(new Map());

  // Re-enable sorting when any filter changes so the new view is properly sorted
  useEffect(() => {
    setSortActive(true);
  }, [showMode, myThreadsFilter, myCommentsFilter, suggestionsOnly, searchFilter]);

  // IDs of comments animating out (slide collapse) before removal from the filtered list
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  // Increment to signal all rows to expand or collapse
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);

  function wouldBeFilteredOut(c: Comment): boolean {
    if (suggestionsOnly && c.type !== "SUGGESTION") return true;
    if (showMode === "inbox" && (c.status === "ARCHIVED" || c.status === "MUTED")) return true;
    if (showMode === "open" && c.resolved) return true;
    if (showMode === "resolved" && !c.resolved) return true;
    if (myThreadsFilter && !c.iParticipated) return true;
    if (myCommentsFilter && !c.isThreadAuthor) return true;
    if (unrepliedFilter && c.isRead) return true;
    return false;
  }

  function handleSort(col: SortCol) {
    setSortActive(true);
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${doc.docId}/refresh`, { method: "POST", contextId });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithComments = await res.json();
      setDoc(updated);
      setComments(updated.comments);
      setSortActive(true);
      void fetchContent(contextId);
      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      toast.success("Comments synced");
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to sync comments");
    } finally {
      setRefreshing(false);
    }
  }

  function handleEditSave(updated: DocWithLabels) {
    setDoc((prev) => ({ ...prev, role: updated.role, labels: updated.labels, status: updated.status, notes: updated.notes }));
  }

  async function handleArchive() {
    setArchiving(true);
    const contextId = generateContextId();
    try {
      const newStatus = doc.status === "INBOX" ? "ARCHIVED" : "INBOX";
      const res = await apiFetch(`/api/docs/${doc.docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      setDoc((prev) => ({ ...prev, status: updated.status }));
      broadcastChange({ type: "docs", docId: doc.docId }, contextId);
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  async function handleBulkStatusChange(fromStatus: "INBOX" | "ARCHIVED", toStatus: "INBOX" | "ARCHIVED") {
    const targets = filteredComments.filter((c) => c.status === fromStatus);
    if (targets.length === 0) return;

    const setBusy = toStatus === "ARCHIVED" ? setBulkArchiving : setBulkUnarchiving;
    const verb = toStatus === "ARCHIVED" ? "archive" : "unarchive";
    const pastVerb = toStatus === "ARCHIVED" ? "Archived" : "Unarchived";

    setBusy(true);
    const contextId = generateContextId();
    try {
      const commentIds = targets.map((c) => c.commentId);
      const res = await apiFetch(`/api/docs/${doc.docId}/comments`, {
        method: "PATCH",
        body: JSON.stringify({ commentIds, status: toStatus }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");

      const { count } = await res.json();
      setComments((prev) =>
        prev.map((c) =>
          commentIds.includes(c.commentId) ? { ...c, status: toStatus } : c
        )
      );

      // Trigger animations for comments that are now filtered out
      targets.forEach(c => {
        const updated = { ...c, status: toStatus };
        if (wouldBeFilteredOut(updated)) {
          setExitingIds((prev) => new Set(prev).add(updated.commentId));
        }
      });

      setTimeout(() => {
        setExitingIds((prev) => {
          const next = new Set(prev);
          targets.forEach(c => next.delete(c.commentId));
          return next;
        });
      }, 200);

      broadcastChange({ type: "comments", docId: doc.docId }, contextId);
      toast.success(`${pastVerb} ${count} comments`);
    } catch {
      toast.error(`Failed to ${verb} comments`);
    } finally {
      setBusy(false);
    }
  }

  function handleArchiveAll() { void handleBulkStatusChange("INBOX", "ARCHIVED"); }
  function handleUnarchiveAll() { void handleBulkStatusChange("ARCHIVED", "INBOX"); }

  function handleCommentUpdate(updated: Comment) {
    setSortActive(false);
    if (wouldBeFilteredOut(updated)) {
      setExitingIds((prev) => new Set(prev).add(updated.commentId));
      setTimeout(() => {
        setExitingIds((prev) => {
          if (!prev.has(updated.commentId)) return prev;
          const next = new Set(prev);
          next.delete(updated.commentId);
          return next;
        });
      }, 200);
    }
    setComments((prev) => prev.map((c) => (c.commentId === updated.commentId ? updated : c)));
  }

  const matcher = useMemo(() => createMatcher(searchFilter), [searchFilter]);

  const filteredComments = comments
    .filter((c) => exitingIds.has(c.commentId) || !wouldBeFilteredOut(c))
    .filter((c) => {
      if (!searchFilter) return true;
      // commentContent and threadText both derive from threadMap so the initial
      // comment text appears twice in the search string — harmless for matching.
      const text = commentContent[c.googleCommentId] ?? "";
      const sug = suggestionContent[c.googleCommentId];
      const sugText = sug ? `${sug.deletedText} ${sug.insertedText}` : "";
      const threads = threadText[c.googleCommentId] ?? "";
      const combined = `${text} ${sugText} ${threads}`;
      return matcher(combined);
    })
    .sort((a, b) => {
      if (!sortActive) {
        const aPos = frozenOrderRef.current.get(a.commentId) ?? Infinity;
        const bPos = frozenOrderRef.current.get(b.commentId) ?? Infinity;
        return aPos - bPos;
      }
      let cmp = 0;
      if (sortCol === "driveCreatedAt" || sortCol === "driveModifiedAt") {
        const aTime = a[sortCol] ? new Date(a[sortCol]!).getTime() : 0;
        const bTime = b[sortCol] ? new Date(b[sortCol]!).getTime() : 0;
        cmp = aTime - bTime;
      } else if (sortCol === "replyCount") {
        cmp = a.replyCount - b.replyCount;
      } else {
        cmp = (a[sortCol] ? 1 : 0) - (b[sortCol] ? 1 : 0);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  // Snapshot display order while sort is active so we can freeze it later
  if (sortActive) {
    frozenOrderRef.current = new Map(filteredComments.map((c, i) => [c.commentId, i]));
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (!sortActive || sortCol !== col) return <span className="ml-1 text-zinc-300">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, title, children }: { col: SortCol; title?: string; children: React.ReactNode }) {
    return (
      <th className="py-2.5 pr-4 text-left">
        <button
          onClick={() => handleSort(col)}
          title={title}
          className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
        >
          {children}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  useEffect(() => {
    document.title = `Docreview: ${doc.title}`;
  }, [doc.title]);

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="text-xl font-semibold text-zinc-900">Document not found</div>
        <p className="text-zinc-500">This document may have been deleted in another tab.</p>
        <Button variant="outline" asChild>
          <a href="/docs">Back to document list</a>
        </Button>
      </div>
    );
  }

  return (
    <LabelProvider allLabels={labels} onLabelsChange={setLabels} onLabelDelete={handleLabelDelete}>
    <div className="flex flex-col gap-6">
      {doc.isDeleted && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
          <span className="font-bold">Note:</span> This document was deleted from Google Drive or is no longer accessible.
        </div>
      )}
      {/* Header row: title left, buttons right */}
      <div className="flex items-start justify-between">
        <div className="flex items-baseline text-xl font-semibold pt-1">
          <span className="flex-shrink-0 text-zinc-500 mr-2">Docreview:</span>
          <DocTypeIcon mimeType={doc.mimeType} className="h-5 w-5 flex-shrink-0 translate-y-[3px] mr-1" />
          <a
            href={doc.driveUrl}
            target="docreview-doc"
            title="Open document"
            className={`hover:underline hover:text-blue-600 ${
              doc.isDeleted ? "line-through text-zinc-400" : "text-zinc-900"
            }`}
          >{doc.title}</a>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" title="Back to the document list" className="text-zinc-900" asChild>
            <a href="/docs">Doc list</a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh comments"
            className="text-zinc-900"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Metadata */}
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-600">
          <span>
            <span className="font-medium text-zinc-400">Owner:</span>{" "}
            {doc.owner ?? "—"}
          </span>
          <span>
            <span className="font-medium text-zinc-400">Created:</span>{" "}
            <FriendlyDate date={doc.createdTimeInDrive} />
          </span>
          <span>
            <span className="font-medium text-zinc-400">Modified:</span>{" "}
            <FriendlyDate date={doc.lastModifiedInDrive} />
          </span>
          <span>
            <span className="font-medium text-zinc-400">DocId:</span>{" "}
            {doc.googleDocId}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-zinc-600">
          <span className="font-medium text-zinc-400">Labels:</span>
          {doc.role === "AUTHOR" && (
            <span title="You are an author of this document" className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${ROLE_COLORS.AUTHOR.badge}`}>
              Author
            </span>
          )}
          {doc.labels.map((dl) => (
            <LabelBadge key={dl.labelId} label={dl.label} />
          ))}
          {doc.role !== "AUTHOR" && doc.labels.length === 0 && (
            <span className="text-zinc-400">—</span>
          )}
          <EditDocDialog
            doc={doc as unknown as DocWithLabels}
            onSave={handleEditSave}
          >
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs text-zinc-900" title="Edit document labels and notes">
              Edit
            </Button>
          </EditDocDialog>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs text-zinc-900"
            title={doc.status === "INBOX" ? "Archive this document" : "Move this document to inbox"}
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === "INBOX" ? "Archive" : "Unarchive"}
          </Button>
        </div>
        {doc.notes?.trim() && (
          <div className="flex gap-2 mt-2 text-sm text-zinc-600">
            <span className="font-medium text-zinc-400 flex-shrink-0 pt-1">Notes:</span>
            <textarea
              readOnly
              value={doc.notes}
              rows={Math.min(doc.notes.split("\n").length, 10)}
              className="flex-1 resize-none rounded border border-zinc-200 bg-zinc-50 px-3 py-1 text-sm text-zinc-700 focus:outline-none max-h-[200px] overflow-y-auto"
            />
          </div>
        )}
      </div>

      {/* Filters */}
      <CommentFilterBar
        myThreadsFilter={myThreadsFilter}
        myCommentsFilter={myCommentsFilter}
        showMode={showMode}
        suggestionsOnly={suggestionsOnly}
        unrepliedFilter={unrepliedFilter}
        searchFilter={searchFilter}
        onMyThreadsChange={setMyThreadsFilter}
        onMyCommentsChange={setMyCommentsFilter}
        onShowModeChange={setShowMode}
        onSuggestionsOnlyChange={setSuggestionsOnly}
        onUnrepliedChange={setUnrepliedFilter}
        onSearchFilterChange={setSearchFilter}
      />

      {/* Comment table */}
      {filteredComments.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {comments.length === 0
            ? 'No comments yet. Click "Refresh" to sync.'
            : "No comments match the current filters."}
        </p>
      ) : (
        <div className="rounded-lg border border-zinc-200">
          <table className="w-full min-w-fit">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="pl-4 py-2.5 pr-4 text-left">
                  <button
                    onClick={() => handleSort("driveCreatedAt")}
                    title="Thread creation time"
                    className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
                  >
                    Created<SortIcon col="driveCreatedAt" />
                  </button>
                </th>
                <ThButton col="driveModifiedAt" title="Thread last-modified time">Modified</ThButton>
                <ThButton col="replyCount" title="Number of replies">Responses</ThButton>
                <ThButton col="iParticipated" title="Whether I created or replied">Created</ThButton>
                <ThButton col="resolved" title="Whether comment is open or resolved">Status</ThButton>
                <th className="pr-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Expand all comment threads"
                      onClick={() => setExpandSignal((n) => n + 1)}
                    >
                      Expand all
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[10px] text-zinc-900"
                      title="Collapse all comment threads"
                      onClick={() => setCollapseSignal((n) => n + 1)}
                    >
                      Collapse all
                    </Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-5 px-1 text-zinc-900"
                          title="More actions"
                        >
                          <Menu className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={handleArchiveAll}
                          disabled={bulkArchiving || !filteredComments.some((c) => c.status === "INBOX")}
                        >
                          <Archive className="h-4 w-4 mr-2" />
                          {bulkArchiving ? "Archiving..." : "Archive all"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={handleUnarchiveAll}
                          disabled={bulkUnarchiving || !filteredComments.some((c) => c.status === "ARCHIVED")}
                        >
                          <ArchiveRestore className="h-4 w-4 mr-2" />
                          {bulkUnarchiving ? "Unarchiving..." : "Unarchive all"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filteredComments.map((comment) => (
                <CommentRow
                  key={comment.commentId}
                  comment={comment}
                  docId={doc.docId}
                  driveUrl={doc.driveUrl}
                  content={comment.type === "COMMENT" ? commentContent[comment.googleCommentId] : undefined}
                  suggestionContent={comment.type === "SUGGESTION" ? suggestionContent[comment.googleCommentId] : undefined}
                  initialThread={comment.type === "COMMENT" ? threadMap[comment.googleCommentId] : undefined}
                  onUpdate={handleCommentUpdate}
                  onThreadUpdate={handleThreadUpdate}
                  isExiting={exitingIds.has(comment.commentId)}
                  searchFilter={searchFilter}
                  documentText={documentText}
                  expandSignal={expandSignal}
                  collapseSignal={collapseSignal}
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

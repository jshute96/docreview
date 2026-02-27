"use client";

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { Comment, Label } from "@prisma/client";
import type { DocWithComments, DocWithLabels } from "@/types";
import type { SuggestionContent } from "@/lib/google-drive";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { LabelBadge } from "@/components/label-badge";
import { EditDocDialog } from "@/components/edit-doc-dialog";
import { ROLE_COLORS } from "@/lib/role-colors";
import { CommentFilterBar } from "@/components/comment-filter-bar";
import { CommentRow } from "@/components/comment-row";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

interface DocDetailProps {
  doc: DocWithComments;
  allLabels: Label[];
}

export function DocDetail({ doc: initialDoc, allLabels }: DocDetailProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [comments, setComments] = useState<Comment[]>(initialDoc.comments);
  const [archiving, setArchiving] = useState(false);
  const [commentContent, setCommentContent] = useState<Record<string, string>>({});
  const [suggestionContent, setSuggestionContent] = useState<Record<string, SuggestionContent>>({});

  async function fetchContent() {
    try {
      const res = await fetch(`/api/docs/${doc.id}/comments`);
      if (res.ok) {
        const data = await res.json();
        setCommentContent(data.comments ?? {});
        setSuggestionContent(data.suggestions ?? {});
      }
    } catch { /* content is optional */ }
  }

  useEffect(() => { void fetchContent(); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [myThreadsFilter, setMyThreadsFilter] = useState(false);
  const [myCommentsFilter, setMyCommentsFilter] = useState(false);
  const [showMode, setShowMode] = useState<"active" | "open" | "all">("active");
  const [suggestionsOnly, setSuggestionsOnly] = useState(false);
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
  // IDs of comments animating out (slide collapse) before removal from the filtered list
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());

  function wouldBeFilteredOut(c: Comment): boolean {
    if (suggestionsOnly && c.type !== "SUGGESTION") return true;
    if (showMode === "active" && (c.status === "ARCHIVED" || c.status === "MUTED")) return true;
    if (showMode === "open" && c.resolved) return true;
    if (myThreadsFilter && !c.iParticipated) return true;
    if (myCommentsFilter && !c.isThreadAuthor) return true;
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
    try {
      const res = await fetch(`/api/docs/${doc.id}/refresh`, { method: "POST" });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithComments = await res.json();
      setDoc(updated);
      setComments(updated.comments);
      setSortActive(true);
      void fetchContent();
      toast.success("Comments synced");
    } catch {
      toast.error("Failed to sync comments");
    } finally {
      setRefreshing(false);
    }
  }

  function handleEditSave(updated: DocWithLabels) {
    setDoc((prev) => ({ ...prev, role: updated.role, labels: updated.labels, status: updated.status }));
  }

  async function handleArchive() {
    setArchiving(true);
    try {
      const newStatus = doc.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
      const res = await fetch(`/api/docs/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed");
      const updated: DocWithLabels = await res.json();
      setDoc((prev) => ({ ...prev, status: updated.status }));
      toast.success(newStatus === "ARCHIVED" ? "Archived" : "Unarchived");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setArchiving(false);
    }
  }

  function handleCommentUpdate(updated: Comment) {
    setSortActive(false);
    if (wouldBeFilteredOut(updated)) {
      setExitingIds((prev) => new Set(prev).add(updated.id));
      setTimeout(() => {
        setExitingIds((prev) => {
          if (!prev.has(updated.id)) return prev;
          const next = new Set(prev);
          next.delete(updated.id);
          return next;
        });
      }, 200);
    }
    setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  const filteredComments = comments
    .filter((c) => exitingIds.has(c.id) || !wouldBeFilteredOut(c))
    .sort((a, b) => {
      if (!sortActive) {
        const aPos = frozenOrderRef.current.get(a.id) ?? Infinity;
        const bPos = frozenOrderRef.current.get(b.id) ?? Infinity;
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
    frozenOrderRef.current = new Map(filteredComments.map((c, i) => [c.id, i]));
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

  return (
    <div className="flex flex-col gap-6">
      {/* Header row: title left, buttons right */}
      <div className="flex items-start justify-between">
        <div className="flex items-baseline text-xl font-semibold pt-1">
          <span className="flex-shrink-0 text-zinc-500 mr-2">Docreview:</span>
          <DocTypeIcon mimeType={doc.mimeType} className="h-5 w-5 flex-shrink-0 translate-y-[3px] mr-1" />
          <a
            href={doc.driveUrl}
            target="docreview-doc"
            title="Open document"
            className="text-zinc-900 hover:underline hover:text-blue-600"
          >{doc.title}</a>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" title="Back to the document list" asChild>
            <a href="/docs">Doc list</a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh comments"
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
            {formatDate(doc.createdTimeInDrive)}
          </span>
          <span>
            <span className="font-medium text-zinc-400">Modified:</span>{" "}
            {formatDate(doc.lastModifiedInDrive)}
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
          <EditDocDialog doc={doc as unknown as DocWithLabels} allLabels={allLabels} onSave={handleEditSave}>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Edit document properties and labels">
              Edit
            </Button>
          </EditDocDialog>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={doc.status === "ACTIVE" ? "Hide this document in document list" : "Unhide this document in document list"}
            onClick={handleArchive}
            disabled={archiving}
          >
            {doc.status === "ACTIVE" ? "Archive" : "Unarchive"}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <CommentFilterBar
        myThreadsFilter={myThreadsFilter}
        myCommentsFilter={myCommentsFilter}
        showMode={showMode}
        suggestionsOnly={suggestionsOnly}
        onMyThreadsChange={setMyThreadsFilter}
        onMyCommentsChange={setMyCommentsFilter}
        onShowModeChange={setShowMode}
        onSuggestionsOnlyChange={setSuggestionsOnly}
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
          <table className="w-full">
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
                <th className="pr-4 py-2.5 text-left text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {filteredComments.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  docId={doc.id}
                  driveUrl={doc.driveUrl}
                  content={comment.type === "COMMENT" ? commentContent[comment.googleCommentId] : undefined}
                  suggestionContent={comment.type === "SUGGESTION" ? suggestionContent[comment.googleCommentId] : undefined}
                  onUpdate={handleCommentUpdate}
                  isExiting={exitingIds.has(comment.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

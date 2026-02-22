"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { Comment } from "@prisma/client";
import type { DocWithComments } from "@/types";
import type { SuggestionContent } from "@/lib/google-drive";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { CommentFilterBar } from "@/components/comment-filter-bar";
import { CommentRow } from "@/components/comment-row";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

interface DocDetailProps {
  doc: DocWithComments;
}

export function DocDetail({ doc: initialDoc }: DocDetailProps) {
  const [doc, setDoc] = useState(initialDoc);
  const [comments, setComments] = useState<Comment[]>(initialDoc.comments);
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
  type SortCol = "driveCreatedAt" | "driveModifiedAt" | "replyCount" | "isMine" | "iParticipated" | "resolved";
  type SortDir = "asc" | "desc";
  const [sortCol, setSortCol] = useState<SortCol>("driveModifiedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function handleSort(col: SortCol) {
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
      void fetchContent();
      toast.success("Comments synced");
    } catch {
      toast.error("Failed to sync comments");
    } finally {
      setRefreshing(false);
    }
  }

  function handleCommentUpdate(updated: Comment) {
    setComments((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  const filteredComments = comments
    .filter((c) => {
      if (suggestionsOnly && c.type !== "SUGGESTION") return false;
      if (showMode === "active" && (c.status === "ARCHIVED" || c.status === "MUTED")) return false;
      if (showMode === "open" && c.resolved) return false;
      if (myThreadsFilter && !c.isMine && !c.iParticipated) return false;
      if (myCommentsFilter && !c.isMine) return false;
      return true;
    })
    .sort((a, b) => {
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

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="ml-1 text-zinc-300">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  function ThButton({ col, children }: { col: SortCol; children: React.ReactNode }) {
    return (
      <th className="py-2.5 pr-4 text-left">
        <button
          onClick={() => handleSort(col)}
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
            className="text-zinc-900 hover:underline hover:text-blue-600"
          >{doc.title}</a>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" asChild>
            <a href="/docs">Doc list</a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
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
                    className="flex items-center text-xs font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-800"
                  >
                    Created<SortIcon col="driveCreatedAt" />
                  </button>
                </th>
                <ThButton col="driveModifiedAt">Modified</ThButton>
                <ThButton col="replyCount">Responses</ThButton>
                <ThButton col="isMine">Mine</ThButton>
                <ThButton col="iParticipated">Replied</ThButton>
                <ThButton col="resolved">Status</ThButton>
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
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

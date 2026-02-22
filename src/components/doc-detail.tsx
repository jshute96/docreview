"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { Comment } from "@prisma/client";
import type { DocWithComments } from "@/types";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { CommentFilterBar } from "@/components/comment-filter-bar";
import { CommentRow } from "@/components/comment-row";
import { Button } from "@/components/ui/button";

interface DocDetailProps {
  doc: DocWithComments;
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function DocDetail({ doc }: DocDetailProps) {
  const [comments, setComments] = useState<Comment[]>(doc.comments);
  const [commentContent, setCommentContent] = useState<Record<string, string>>({});

  async function fetchContent() {
    try {
      const res = await fetch(`/api/docs/${doc.id}/comments`);
      if (res.ok) setCommentContent(await res.json());
    } catch { /* content is optional */ }
  }

  useEffect(() => { void fetchContent(); }, [doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [myThreadsFilter, setMyThreadsFilter] = useState(false);
  const [myCommentsFilter, setMyCommentsFilter] = useState(false);
  const [showMode, setShowMode] = useState<"active" | "open" | "all">("active");
  type SortCol = "driveCreatedAt" | "driveModifiedAt" | "replyCount" | "isMine" | "iParticipated" | "resolved";
  type SortDir = "asc" | "desc";
  const [sortCol, setSortCol] = useState<SortCol>("driveCreatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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

  return (
    <div className="flex flex-col gap-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <Link
          href="/docs"
          className="text-sm text-zinc-500 hover:text-zinc-800 transition-colors"
        >
          ← Doc list
        </Link>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Syncing…" : "Refresh"}
        </Button>
      </div>

      {/* Title */}
      <div className="flex items-center gap-2">
        <DocTypeIcon mimeType={doc.mimeType} className="h-5 w-5 flex-shrink-0" />
        <a
          href={doc.driveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xl font-semibold text-zinc-900 hover:underline hover:text-blue-600"
        >
          {doc.title}
        </a>
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
        onMyThreadsChange={setMyThreadsFilter}
        onMyCommentsChange={setMyCommentsFilter}
        onShowModeChange={setShowMode}
      />

      {/* Comment table */}
      {filteredComments.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-400">
          {comments.length === 0
            ? 'No comments yet. Click "Refresh" to sync.'
            : "No comments match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200">
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
                  content={commentContent[comment.googleCommentId]}
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

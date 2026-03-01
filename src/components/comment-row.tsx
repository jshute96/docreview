"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { Comment } from "@prisma/client";
import type { CommentThread, SuggestionContent } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { CommentThreadPanel } from "@/components/comment-thread-panel";
import { highlightText } from "@/lib/highlight";
import { formatDate } from "@/lib/utils";
import { broadcastChange } from "@/lib/cross-tab";

interface CommentRowProps {
  comment: Comment;
  docId: string;
  driveUrl: string;
  content?: string;
  suggestionContent?: SuggestionContent;
  initialThread?: CommentThread;
  onUpdate: (updated: Comment) => void;
  onThreadUpdate?: (googleCommentId: string, thread: CommentThread) => void;
  isExiting?: boolean;
  searchFilter?: string;
  documentText?: string;
  expandSignal?: number;
  collapseSignal?: number;
}

function splitContent(raw: string): { author: string | null; text: string } {
  const sep = raw.indexOf(": ");
  if (sep === -1) return { author: null, text: raw };
  return { author: raw.slice(0, sep), text: raw.slice(sep + 2) };
}

export function CommentRow({ comment, docId, driveUrl, content, suggestionContent, initialThread, onUpdate, onThreadUpdate, isExiting, searchFilter, documentText, expandSignal, collapseSignal }: CommentRowProps) {
  const isSuggestion = comment.type === "SUGGESTION";
  const currentModifiedMs = comment.driveModifiedAt
    ? new Date(comment.driveModifiedAt).getTime()
    : 0;

  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hasBeenExpanded, setHasBeenExpanded] = useState(false);
  const [threads, setThreads] = useState<CommentThread[]>(initialThread ? [initialThread] : []);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [refreshingThread, setRefreshingThread] = useState(false);
  const [hasDirtyReply, setHasDirtyReply] = useState(false);
  // Epoch ms of driveModifiedAt at the time threads were last fetched
  const fetchedModifiedMs = useRef<number | null>(initialThread ? currentModifiedMs : null);

  // Sync threads state when parent re-fetches threadMap (e.g., global refresh)
  useEffect(() => {
    if (!initialThread) return;
    setThreads([initialThread]);
    const modMs = initialThread.modifiedTime
      ? new Date(initialThread.modifiedTime).getTime()
      : currentModifiedMs;
    fetchedModifiedMs.current = modMs;
  }, [initialThread]); // eslint-disable-line react-hooks/exhaustive-deps

  function commentUrl() {
    const url = new URL(driveUrl);
    url.searchParams.set("disco", comment.googleCommentId);
    return url.toString();
  }

  function applyThreadUpdate(data: { threads: CommentThread[]; comment: Comment }) {
    setThreads(data.threads);
    if (onThreadUpdate && data.threads.length > 0) {
      onThreadUpdate(comment.googleCommentId, data.threads[0]);
    }
    onUpdate(data.comment);
    fetchedModifiedMs.current = data.comment.driveModifiedAt
      ? new Date(data.comment.driveModifiedAt).getTime()
      : 0;
  }

  // TODO: consider AbortController to cancel in-flight requests on unmount
  async function fetchThread() {
    setLoadingThreads(true);
    try {
      const res = await fetch(`/api/docs/${docId}/threads?commentId=${comment.googleCommentId}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setThreads(data.threads);
      if (onThreadUpdate && data.threads.length > 0) {
        onThreadUpdate(comment.googleCommentId, data.threads[0]);
      }
      fetchedModifiedMs.current = currentModifiedMs;
    } catch {
      toast.error("Failed to load comment thread");
    } finally {
      setLoadingThreads(false);
    }
  }

  async function refreshThread() {
    setRefreshingThread(true);
    try {
      const res = await fetch(
        `/api/docs/${docId}/threads?commentId=${comment.googleCommentId}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("Failed");
      applyThreadUpdate(await res.json());
    } catch {
      toast.error("Failed to refresh comment");
    } finally {
      setRefreshingThread(false);
    }
  }

  // Cheap background check: ask Drive for modifiedTime only, full refresh if changed
  async function backgroundCheck() {
    try {
      const res = await fetch(
        `/api/docs/${docId}/threads?commentId=${comment.googleCommentId}&checkOnly=true`
      );
      if (!res.ok) return;
      const data = await res.json();
      const driveMs = data.modifiedTime ? new Date(data.modifiedTime).getTime() : 0;
      if (driveMs !== fetchedModifiedMs.current) {
        // Drive has newer data — do a full silent refresh
        const refreshRes = await fetch(
          `/api/docs/${docId}/threads?commentId=${comment.googleCommentId}`,
          { method: "POST" }
        );
        if (!refreshRes.ok) return;
        applyThreadUpdate(await refreshRes.json());
      }
    } catch {
      // Silent — background check
    }
  }

  async function refreshSuggestion() {
    setRefreshingThread(true);
    try {
      const res = await fetch(
        `/api/docs/${docId}/threads?commentId=${comment.googleCommentId}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      onUpdate(data.comment);
    } catch {
      toast.error("Failed to refresh suggestion");
    } finally {
      setRefreshingThread(false);
    }
  }

  // Auto-refetch when driveModifiedAt changes while expanded (e.g., after page Refresh)
  useEffect(() => {
    if (!expanded || isSuggestion) return;
    if (fetchedModifiedMs.current === null) return; // initial fetch handled by handleRowClick
    if (fetchedModifiedMs.current === currentModifiedMs) return;
    fetchThread();
  }, [expanded, currentModifiedMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expand All — just set UI state; thread data is already pre-fetched
  useEffect(() => {
    if (!expandSignal || expanded) return;
    setHasBeenExpanded(true);
    setExpanded(true);
  }, [expandSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!collapseSignal || !expanded || hasDirtyReply) return;
    setExpanded(false);
  }, [collapseSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRowClick() {
    if (!expanded) {
      if (!isSuggestion) {
        if (fetchedModifiedMs.current === null || fetchedModifiedMs.current !== currentModifiedMs) {
          // First open, or stale from a page Refresh — full fetch
          fetchThread();
        } else {
          // Re-open with locally-fresh data — background check against Drive
          backgroundCheck();
        }
      }
      setHasBeenExpanded(true);
      setExpanded(true);
    } else {
      if (hasDirtyReply) {
        toast.error("Clear or send the reply before closing");
        return;
      }
      setExpanded(false);
    }
  }

  async function postReply(
    body: Record<string, unknown>,
    errorMsg: string,
    successMsg: string,
  ) {
    const res = await fetch(`/api/docs/${docId}/threads/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast.error(errorMsg);
      throw new Error("Failed");
    }
    applyThreadUpdate(await res.json());
    broadcastChange({ type: "comments", docId });
    toast.success(successMsg);
  }

  async function handleReply(content: string) {
    await postReply(
      { commentId: comment.googleCommentId, content },
      "Failed to post reply",
      "Reply posted",
    );
  }

  async function handleResolve(content: string) {
    await postReply(
      { commentId: comment.googleCommentId, content: content || undefined, resolve: true },
      "Failed to resolve comment",
      content ? "Replied and resolved" : "Comment resolved",
    );
  }

  async function handleReopen(content: string) {
    await postReply(
      { commentId: comment.googleCommentId, content: content || "" },
      "Failed to reopen comment",
      content ? "Replied and reopened" : "Comment reopened",
    );
  }

  async function updateStatus(status: "ACTIVE" | "ARCHIVED" | "MUTED") {
    setLoading(true);
    try {
      const res = await fetch(`/api/docs/${docId}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed");
      const updated: Comment = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "comments", docId });
      toast.success(`Comment ${status.toLowerCase()}`);
    } catch {
      toast.error("Failed to update comment");
    } finally {
      setLoading(false);
    }
  }

  const isArchived = comment.status === "ARCHIVED";
  const isMuted = comment.status === "MUTED";

  const sameAsCreated =
    comment.driveCreatedAt &&
    comment.driveModifiedAt &&
    new Date(comment.driveCreatedAt).getTime() === new Date(comment.driveModifiedAt).getTime();

  const hasContentRow = isSuggestion ? (!!suggestionContent || comment.resolved) : !!content;
  const cellPy = hasContentRow ? "pt-1.5 pb-0" : "py-1.5";
  const { author, text } = content ? splitContent(content) : { author: null, text: "" };
  const rowBg = hovered ? "bg-zinc-50" : "";
  const rowCls = isExiting ? "pointer-events-none" : "transition-colors";
  const cellWrap = `grid${isExiting ? " transition-[grid-template-rows] duration-200 ease-out" : ""}`;
  const cellWrapStyle = { gridTemplateRows: isExiting ? "0fr" : "1fr" };
  const cell = (cls: string, children: React.ReactNode) => (
    <td>
      <div className={cellWrap} style={cellWrapStyle}>
        <div className={`overflow-hidden min-h-0 ${cls}`}>{children}</div>
      </div>
    </td>
  );

  const hoverHandlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };

  const suggestionLabel =
    comment.suggestionType === "INSERT"
      ? "Suggested add"
      : comment.suggestionType === "DELETE"
      ? "Suggested delete"
      : "Suggested edit";

  return (
    <>
    <tr
      className={`${rowBg} ${rowCls} cursor-pointer${hasContentRow || expanded || isExiting ? "" : " border-b border-zinc-100"}`}
      onClick={handleRowClick}
      {...hoverHandlers}
    >
      {cell(`${cellPy} pl-4 pr-4 text-sm text-zinc-500 whitespace-nowrap`,
        formatDate(comment.driveCreatedAt)
      )}
      {cell(`${cellPy} pr-4 text-sm text-zinc-500 whitespace-nowrap`,
        sameAsCreated ? "—" : formatDate(comment.driveModifiedAt)
      )}
      {cell(`${cellPy} pr-4 text-sm text-zinc-500 tabular-nums`,
        comment.replyCount > 0 ? comment.replyCount : ""
      )}
      {cell(`${cellPy} pr-4`,
        !isSuggestion && comment.isThreadAuthor ? (
          <span title="You started this thread" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700">
            Mine
          </span>
        ) : !isSuggestion && comment.iParticipated ? (
          <span title="You replied in this thread" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700">
            Replied
          </span>
        ) : null
      )}
      {cell(`${cellPy} pr-4`,
        comment.resolved ? (
          <span title="This comment has been resolved" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500">
            Resolved
          </span>
        ) : (
          <span title="This comment is unresolved" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
            Open
          </span>
        )
      )}
      {cell(`${cellPy} pr-4`,
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title="Open the document at this comment"
            asChild
          >
            <a href={commentUrl()} target="docreview-doc">
              Open
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={isArchived ? "Unhide this comment" : "Hide this comment"}
            onClick={() => updateStatus(isArchived ? "ACTIVE" : "ARCHIVED")}
            disabled={loading}
          >
            {isArchived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={isMuted ? "Permanently hidden — click to unhide" : "Permanently hide this comment"}
            onClick={() => updateStatus(isMuted ? "ACTIVE" : "MUTED")}
            disabled={loading}
          >
            {isMuted ? "Unmute" : "Mute"}
          </Button>
        </div>
      )}
    </tr>
    {hasContentRow && (
      <tr
        className={`${rowBg}${expanded || isExiting ? "" : " border-b border-zinc-100"} ${rowCls} cursor-pointer`}
        onClick={handleRowClick}
        {...hoverHandlers}
      >
        <td colSpan={6} className="max-w-0 overflow-hidden">
          <div className={cellWrap} style={cellWrapStyle}>
            <div className="overflow-hidden min-h-0 pt-0.5 pb-2 pl-4 pr-4">
          {isSuggestion && !suggestionContent && comment.resolved ? (
            <p className="truncate text-sm text-zinc-400 italic">Resolved suggestion</p>
          ) : isSuggestion && suggestionContent ? (
            <p className="truncate text-sm text-zinc-400">
              <span className="text-zinc-500">{suggestionLabel}: </span>
              {(comment.suggestionType === "EDIT" || comment.suggestionType === "DELETE") && (
                <span className="line-through text-red-400">{highlightText(suggestionContent.deletedText, searchFilter ?? "")}</span>
              )}
              {comment.suggestionType === "EDIT" && (
                <span className="text-zinc-400"> → </span>
              )}
              {(comment.suggestionType === "EDIT" || comment.suggestionType === "INSERT") && (
                <span className="text-zinc-600">{highlightText(suggestionContent.insertedText, searchFilter ?? "")}</span>
              )}
            </p>
          ) : (
            <p className="truncate text-sm text-zinc-400">
              <span>
                {author && <span className="text-zinc-600">{highlightText(author, searchFilter ?? "")}: </span>}
                {highlightText(text, searchFilter ?? "")}
              </span>
            </p>
          )}
            </div>
          </div>
        </td>
      </tr>
    )}
    {hasBeenExpanded && (
      <tr className={`${expanded && !isExiting ? "border-b border-zinc-100" : ""}${isExiting ? " pointer-events-none" : ""}`}>
        <td colSpan={6} className="p-0">
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: expanded && !isExiting ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden min-h-0">
              {isSuggestion ? (
                <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
                  <div className="float-right relative z-10 flex gap-1 ml-2 mb-1">
                    <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Open the document at this comment" asChild>
                      <a href={commentUrl()} target="docreview-doc">
                        Open
                      </a>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      title="Refresh this thread"
                      onClick={refreshSuggestion}
                      disabled={refreshingThread}
                    >
                      <RefreshCw className={`h-3 w-3 mr-1 ${refreshingThread ? "animate-spin" : ""}`} />
                      Refresh
                    </Button>
                  </div>
                  {suggestionContent && (
                    <div className="mb-3 text-sm whitespace-pre-wrap">
                      <span className="text-zinc-500">{suggestionLabel}: </span>
                      {(comment.suggestionType === "EDIT" || comment.suggestionType === "DELETE") && (
                        <span className="line-through text-red-400">{highlightText(suggestionContent.deletedText, searchFilter ?? "")}</span>
                      )}
                      {comment.suggestionType === "EDIT" && (
                        <span className="text-zinc-400"> → </span>
                      )}
                      {(comment.suggestionType === "EDIT" || comment.suggestionType === "INSERT") && (
                        <span className="text-zinc-600">{highlightText(suggestionContent.insertedText, searchFilter ?? "")}</span>
                      )}
                    </div>
                  )}
                  <p className="text-sm text-zinc-400">
                    Cannot show comments or accept or remove suggestions. Process suggestions in the doc.
                  </p>
                </div>
              ) : (
                <CommentThreadPanel
                  threads={threads}
                  loading={loadingThreads}
                  resolved={comment.resolved}
                  commentUrl={commentUrl()}
                  onRefresh={refreshThread}
                  refreshing={refreshingThread}
                  onReply={handleReply}
                  onResolve={handleResolve}
                  onReopen={handleReopen}
                  onDirtyChange={setHasDirtyReply}
                  searchFilter={searchFilter}
                  documentText={documentText}
                />
              )}
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

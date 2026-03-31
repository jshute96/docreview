"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import type { Comment } from "@prisma/client";
import type { CommentThread, ThreadMap, SuggestionContent } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { CommentThreadPanel } from "@/components/comment-thread-panel";
import { highlightText } from "@/lib/highlight";
import { FriendlyDate } from "@/components/friendly-date";
import { StarButton } from "@/components/star-button";
import { broadcastChange } from "@/lib/cross-tab";
import { apiFetch, generateContextId, isAuthError } from "@/lib/api-fetch";
import { navigateToComment, supportsCommentNavigation, getSuggestionFromDoc, getExtensionStatus, type ExtensionSuggestion } from "@/lib/bridge-to-extension";
import { extensionToThread, extensionToSuggestionContent } from "@/lib/extension-suggestions";
import { docTarget } from "@/lib/tab-targets";

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
  expandUnreadSignal?: number;
  collapseSignal?: number;
  isSelected?: boolean;
  onSelectInDoc?: () => void;
  onSuggestionRefresh?: (discoId: string, thread: CommentThread, content: SuggestionContent, raw: ExtensionSuggestion) => void;
}

function splitContent(raw: string): { author: string | null; text: string } {
  const sep = raw.indexOf(": ");
  if (sep === -1) return { author: null, text: raw };
  return { author: raw.slice(0, sep), text: raw.slice(sep + 2) };
}

export function CommentRow({ comment, docId, driveUrl, content, suggestionContent, initialThread, onUpdate, onThreadUpdate, isExiting, searchFilter, documentText, expandSignal, expandUnreadSignal, collapseSignal, isSelected, onSelectInDoc, onSuggestionRefresh }: CommentRowProps) {
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

  // Refs for auto-scroll when the comment is selected from the Google Doc tab
  const rowRef = useRef<HTMLTableRowElement>(null);
  const buttonsRowRef = useRef<HTMLDivElement>(null);
  // Suppresses auto-scroll briefly after we initiate a selection from docreview.
  // Without this, clicking a row here sends selectComment to the doc, the doc
  // selects it and echoes commentSelection back, which would scroll the page
  // to the row the user just clicked — jarring since it's already visible.
  const suppressScrollRef = useRef(false);

  // Auto-scroll when this comment becomes selected from the doc. Positions the
  // buttons row (if expanded) or the comment row (if collapsed) at ~80% of
  // viewport height so the user sees the reply area plus as much thread above
  // as possible.
  const prevSelectedRef = useRef(false);
  useEffect(() => {
    const wasSelected = prevSelectedRef.current;
    prevSelectedRef.current = !!isSelected;
    if (!isSelected || wasSelected || suppressScrollRef.current) return;
    requestAnimationFrame(() => {
      const el = (expanded && buttonsRowRef.current) ? buttonsRowRef.current : rowRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const target = window.innerHeight * 0.8;
      const delta = rect.bottom - target;
      // Only scroll if the element bottom isn't already near the target
      if (Math.abs(delta) > 40) {
        window.scrollBy({ top: delta, behavior: "smooth" });
      }
    });
  }, [isSelected, expanded]);

  // Sync threads state when parent re-fetches threadMap (e.g., global refresh)
  useEffect(() => {
    if (!initialThread) return;
    setThreads([initialThread]);
    const modMs = initialThread.modifiedTime
      ? new Date(initialThread.modifiedTime).getTime()
      : currentModifiedMs;
    fetchedModifiedMs.current = modMs;
  }, [initialThread]); // eslint-disable-line react-hooks/exhaustive-deps

  // The thread/suggestion API identifier — googleCommentId for comments, googleSuggestionId
  // for suggestions. Extension-sourced suggestions only have googleCommentId (disco ID).
  const threadId = (isSuggestion ? (comment.googleSuggestionId ?? comment.googleCommentId) : comment.googleCommentId) ?? "";
  const hasDiscoLink = !!comment.googleCommentId;
  const openLabel = hasDiscoLink ? "Open" : "Open doc";
  const openTitle = hasDiscoLink ? "Open the document at this comment" : "Open the document";

  function commentUrl() {
    const url = new URL(driveUrl);
    // Only add disco= when we have a real Drive comment ID (AAA* format).
    // Suggestion IDs (suggest.*) don't work with disco=.
    if (comment.googleCommentId) {
      url.searchParams.set("disco", comment.googleCommentId);
    }
    return url.toString();
  }

  // Extract the Google Doc ID from the Drive URL for tab tracking.
  // The internal docId (Prisma) isn't in the Google Docs URL, but the
  // Google Doc ID (from the /d/XXXXX/ path segment) is.
  const googleDocId = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? docId;

  // If the extension supports in-page navigation, intercept "Open" clicks
  // to navigate without reloading the Google Docs tab. When there's no disco
  // ID (some suggestions), we still use the extension to reuse the same tab
  // rather than opening a new one.
  function handleOpenClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!supportsCommentNavigation()) return;
    e.preventDefault();
    navigateToComment(googleDocId, comment.googleCommentId ?? "", driveUrl, comment.resolved);
  }

  function applyThreadUpdate(data: { threads: ThreadMap; comment: Comment }) {
    const threadList = Object.values(data.threads);
    setThreads(threadList);
    if (onThreadUpdate && threadList.length > 0) {
      onThreadUpdate(threadId, threadList[0]);
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
      const res = await apiFetch(`/api/docs/${docId}/threads?commentId=${threadId}`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const threadList: CommentThread[] = Object.values(data.threads);
      setThreads(threadList);
      if (onThreadUpdate && threadList.length > 0) {
        onThreadUpdate(threadId, threadList[0]);
      }
      fetchedModifiedMs.current = currentModifiedMs;
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to load comment thread");
    } finally {
      setLoadingThreads(false);
    }
  }

  async function refreshThread() {
    setRefreshingThread(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch(
        `/api/docs/${docId}/threads?commentId=${threadId}`,
        { method: "POST", contextId }
      );
      if (!res.ok) throw new Error("Failed");
      applyThreadUpdate(await res.json());
      broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
    } catch (err) {
      if (!isAuthError(err)) toast.error("Failed to refresh comment");
    } finally {
      setRefreshingThread(false);
    }
  }

  // Refresh a suggestion by re-scraping its data from the Google Docs DOM via the extension.
  async function refreshSuggestion() {
    if (!comment.googleCommentId) return;
    setRefreshingThread(true);
    try {
      const suggestion = await getSuggestionFromDoc(googleDocId, comment.googleCommentId);
      if (!suggestion) {
        toast.error("Suggestion not found in the document");
        return;
      }
      const thread = extensionToThread(suggestion);
      const refreshedContent = extensionToSuggestionContent(suggestion);
      setThreads([thread]);
      if (onSuggestionRefresh) {
        onSuggestionRefresh(comment.googleCommentId, thread, refreshedContent, suggestion);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to refresh suggestion");
    } finally {
      setRefreshingThread(false);
    }
  }

  // Cheap background check: ask Drive for modifiedTime only, full refresh if changed.
  // Only called for comments (not suggestions) — threadId is always a googleCommentId here.
  async function backgroundCheck() {
    const contextId = generateContextId();
    try {
      const res = await apiFetch(
        `/api/docs/${docId}/threads?commentId=${threadId}&checkOnly=true`,
        { contextId }
      );
      if (!res.ok) return;
      const data = await res.json();
      const driveMs = data.modifiedTime ? new Date(data.modifiedTime).getTime() : 0;
      if (driveMs !== fetchedModifiedMs.current) {
        // Drive has newer data — do a full silent refresh
        const refreshRes = await apiFetch(
          `/api/docs/${docId}/threads?commentId=${threadId}`,
          { method: "POST", contextId }
        );
        if (!refreshRes.ok) return;
        applyThreadUpdate(await refreshRes.json());
        broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
      }
    } catch {
      // Silent — background check
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

  // Expand All Unread — only expand if this comment is unread
  useEffect(() => {
    if (!expandUnreadSignal || expanded || comment.isRead) return;
    setHasBeenExpanded(true);
    setExpanded(true);
  }, [expandUnreadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!collapseSignal || !expanded || hasDirtyReply) return;
    setExpanded(false);
  }, [collapseSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wrap onSelectInDoc to suppress the auto-scroll that would fire when the
  // doc echoes the selection back. Used by both handleRowClick and the thread
  // panel's click handler.
  function doSelectInDoc() {
    if (!onSelectInDoc) return;
    suppressScrollRef.current = true;
    setTimeout(() => { suppressScrollRef.current = false; }, 2000);
    onSelectInDoc();
  }

  function handleRowClick() {
    doSelectInDoc();
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
    const contextId = generateContextId();
    const res = await apiFetch(`/api/docs/${docId}/threads/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      contextId,
    });
    if (!res.ok) {
      toast.error(errorMsg);
      throw new Error("Failed");
    }
    applyThreadUpdate(await res.json());
    broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
    toast.success(successMsg);
  }

  async function handleReply(content: string) {
    await postReply(
      { commentId: threadId, content },
      "Failed to post reply",
      "Reply posted",
    );
  }

  async function handleResolve(content: string) {
    await postReply(
      { commentId: threadId, content: content || undefined, resolve: true },
      "Failed to resolve comment",
      content ? "Replied and resolved" : "Comment resolved",
    );
  }

  async function handleReopen(content: string) {
    await postReply(
      { commentId: threadId, content: content || "" },
      "Failed to reopen comment",
      content ? "Replied and reopened" : "Comment reopened",
    );
  }

  async function handleReplyAndArchive(content: string) {
    await postReply(
      { commentId: threadId, content },
      "Failed to post reply",
      "Reply posted",
    );
    await updateStatus("ARCHIVED");
  }

  async function updateStatus(status: "INBOX" | "ARCHIVED" | "MUTED") {
    setLoading(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${docId}/comments/${comment.commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: Comment = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
      toast.success(`Comment ${status.toLowerCase()}`);
    } catch {
      toast.error("Failed to update comment");
    } finally {
      setLoading(false);
    }
  }

  async function toggleRead() {
    setLoading(true);
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${docId}/comments/${comment.commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isRead: !comment.isRead }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: Comment = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
    } catch {
      toast.error("Failed to update comment");
    } finally {
      setLoading(false);
    }
  }

  async function toggleStar() {
    const contextId = generateContextId();
    try {
      const res = await apiFetch(`/api/docs/${docId}/comments/${comment.commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isStarred: !comment.isStarred }),
        contextId,
      });
      if (!res.ok) throw new Error("Failed");
      const updated: Comment = await res.json();
      onUpdate(updated);
      broadcastChange({ type: "comments", docId, googleCommentId: threadId, commentType: comment.type }, contextId);
    } catch {
      toast.error("Failed to update star");
    }
  }

  const isArchived = comment.status === "ARCHIVED";
  const isMuted = comment.status === "MUTED";

  const sameAsCreated =
    comment.driveCreatedAt &&
    comment.driveModifiedAt &&
    new Date(comment.driveCreatedAt).getTime() === new Date(comment.driveModifiedAt).getTime();

  const hasContentRow = isSuggestion || !!content;
  const cellPy = hasContentRow ? "pt-1.5 pb-0" : "py-1.5";
  const { author, text } = content ? splitContent(content) : { author: null, text: "" };
  const isAssignedHighlight = comment.status === "INBOX" && comment.assignedToMe && !comment.resolved;
  const isMentionedHighlight = !isAssignedHighlight && comment.status === "INBOX" && comment.mentionedMeUnreplied && !comment.isRead && !comment.resolved;
  const rowBg = isSelected
    ? (hovered ? "bg-blue-200" : "bg-blue-100")
    : isAssignedHighlight
    ? (hovered ? "bg-red-200" : "bg-red-100")
    : isMentionedHighlight
    ? (hovered ? "bg-amber-200" : "bg-amber-100")
    : hovered ? (comment.isRead ? "bg-green-100" : "bg-zinc-50") : (comment.isRead ? "bg-green-50" : "");
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
      ? "suggested add"
      : comment.suggestionType === "DELETE"
      ? "suggested delete"
      : "suggested edit";
  const SuggestionLabel = suggestionLabel.charAt(0).toUpperCase() + suggestionLabel.slice(1);

  const suggestionSummary = isSuggestion ? (
    !suggestionContent && comment.resolved ? (
      <span className="text-zinc-400 italic">Resolved {suggestionLabel}</span>
    ) : !suggestionContent ? (
      <span className="text-zinc-500">{SuggestionLabel}</span>
    ) : (
      <span>
        <span className="text-zinc-500">{SuggestionLabel}: </span>
        {(comment.suggestionType === "EDIT" || comment.suggestionType === "DELETE") && (
          <span className="line-through text-red-400">{highlightText(suggestionContent.deletedText, searchFilter ?? "")}</span>
        )}
        {comment.suggestionType === "EDIT" && (
          <span className="text-zinc-400"> → </span>
        )}
        {(comment.suggestionType === "EDIT" || comment.suggestionType === "INSERT") && (
          <span className="text-zinc-600">{highlightText(suggestionContent.insertedText, searchFilter ?? "")}</span>
        )}
      </span>
    )
  ) : null;

  // Suggestion refresh is only possible when we have a disco ID and the extension
  // is available with Docs integration enabled. Compute disabled state and tooltip.
  // Whether a doc tab is actually open is only known at refresh time (runtime error).
  const extStatus = getExtensionStatus();
  const extensionAvailable = supportsCommentNavigation();
  const suggestionRefreshDisabled = !hasDiscoLink || !extensionAvailable;
  const suggestionRefreshTitle = !extStatus
    ? "Cannot Refresh suggestions: Docreview Chrome extension not loaded"
    : !extStatus.enableDocs
    ? "Cannot Refresh suggestions: Docs integration is disabled in the Docreview Chrome extension"
    : !hasDiscoLink
    ? "Cannot Refresh: Suggestion synced from Drive has no comment ID"
    : "Refresh this suggestion";

  return (
    <>
    <tr
      ref={rowRef}
      className={`${rowBg} ${rowCls}${hasContentRow || expanded || isExiting ? "" : " border-b border-zinc-100"}`}
      onClick={handleRowClick}
      {...hoverHandlers}
    >
      {cell(`${cellPy} pl-4 pr-4 text-sm text-zinc-500 whitespace-nowrap`,
        <FriendlyDate date={comment.driveCreatedAt} />
      )}
      {cell(`${cellPy} pr-4 text-sm text-zinc-500 whitespace-nowrap`,
        sameAsCreated ? "—" : <FriendlyDate date={comment.driveModifiedAt} />
      )}
      {cell(`${cellPy} pr-4 text-sm text-zinc-500 tabular-nums`,
        comment.replyCount > 0 ? comment.replyCount : ""
      )}
      {cell(`${cellPy} flex`,
        // stopPropagation + self-stretch: non-clickable buffer around star/badges
        // so near-miss clicks don't accidentally expand/collapse the row
        <div className="flex items-center gap-1 self-stretch pl-0 pr-1" onClick={(e) => e.stopPropagation()}>
          <StarButton starred={comment.isStarred} onToggle={toggleStar} />
          {!isSuggestion && comment.isThreadAuthor && (
            <span title="You started this thread" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700">
              Mine
            </span>
          )}
          {!isSuggestion && comment.isReplyAuthor && !comment.isThreadAuthor && (
            <span title="You replied in this thread" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700">
              Replied
            </span>
          )}
          {!isSuggestion && comment.assignedToMe && (
            <span title="Comment assigned to you" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-amber-600 text-white">
              Assigned
            </span>
          )}
          {!isSuggestion && comment.mentionedMe && (
            <span title="You were @mentioned in this thread" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700">
              @Mentioned
            </span>
          )}
          {comment.resolved && (
            <span title="This comment has been resolved" className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500">
              Resolved
            </span>
          )}
        </div>
      )}
      {cell(`${cellPy} flex`,
        // stopPropagation + self-stretch: non-clickable buffer around buttons
        // so near-miss clicks don't accidentally expand/collapse the row
        <div className="flex items-center gap-1 self-stretch pl-1 pr-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={openTitle}
            asChild
          >
            <a href={commentUrl()} target={docTarget(googleDocId)} onClick={handleOpenClick}>
              {openLabel}
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={isArchived ? "Unhide this comment" : "Hide this comment"}
            onClick={() => updateStatus(isArchived ? "INBOX" : "ARCHIVED")}
            disabled={loading}
          >
            {isArchived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={comment.isRead ? "Mark as unread" : "Mark as read"}
            onClick={toggleRead}
            disabled={loading}
          >
            {comment.isRead ? "Mark unread" : "Mark read"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title={isMuted ? "Permanently hidden — click to unhide" : "Permanently hide this comment"}
            onClick={() => updateStatus(isMuted ? "INBOX" : "MUTED")}
            disabled={loading}
          >
            {isMuted ? "Unmute" : "Mute"}
          </Button>
        </div>
      )}
    </tr>
    {hasContentRow && !expanded && !isExiting && (
      <tr
        className={`${rowBg}${expanded || isExiting ? "" : " border-b border-zinc-100"} ${rowCls}`}
        onClick={handleRowClick}
        {...hoverHandlers}
      >
        <td colSpan={5} className="max-w-0 overflow-hidden">
          <div className={cellWrap} style={cellWrapStyle}>
            <div className="overflow-hidden min-h-0 pt-0.5 pb-2 pl-4 pr-4">
          {isSuggestion ? (
            <p className="truncate text-sm text-zinc-400">{suggestionSummary}</p>
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
        <td colSpan={5} className="p-0">
          <div
            className="grid transition-[grid-template-rows] duration-200 ease-out"
            style={{ gridTemplateRows: expanded && !isExiting ? "1fr" : "0fr" }}
          >
            <div className={`min-h-0${expanded && !isExiting ? "" : " overflow-hidden"}`}>
              <CommentThreadPanel
                  threads={threads}
                  loading={loadingThreads}
                  resolved={comment.resolved}
                  commentUrl={commentUrl()}
                  openLabel={openLabel}
                  openTitle={openTitle}
                  openTarget={docTarget(googleDocId)}
                  onOpenClick={handleOpenClick}
                  onRefresh={isSuggestion ? refreshSuggestion : refreshThread}
                  refreshing={refreshingThread}
                  refreshDisabled={isSuggestion ? suggestionRefreshDisabled : undefined}
                  refreshTitle={isSuggestion ? suggestionRefreshTitle : undefined}
                  onReply={isSuggestion ? undefined : handleReply}
                  onResolve={isSuggestion ? undefined : handleResolve}
                  onReopen={isSuggestion ? undefined : handleReopen}
                  onReplyAndArchive={isSuggestion ? undefined : handleReplyAndArchive}
                  onArchive={() => updateStatus(isArchived ? "INBOX" : "ARCHIVED")}
                  isArchived={isArchived}
                  onToggleRead={toggleRead}
                  isRead={comment.isRead}
                  onMute={() => updateStatus(isMuted ? "INBOX" : "MUTED")}
                  isMuted={isMuted}
                  onDirtyChange={isSuggestion ? undefined : setHasDirtyReply}
                  searchFilter={searchFilter}
                  documentText={isSuggestion ? undefined : documentText}
                  isSelected={isSelected}
                  onSelectInDoc={onSelectInDoc ? doSelectInDoc : undefined}
                  buttonsRowRef={buttonsRowRef}
                  headerContent={isSuggestion ? (
                    <div className={`mb-3 text-sm${suggestionContent ? " whitespace-pre-wrap" : ""}`}>
                      {suggestionSummary}
                      <p className="mt-1 text-xs text-zinc-300 font-mono">
                        {comment.googleSuggestionId && <span>suggest: {comment.googleSuggestionId} </span>}
                        {comment.googleCommentId && <span>disco: {comment.googleCommentId}</span>}
                        {!comment.googleSuggestionId && !comment.googleCommentId && <span>(no IDs)</span>}
                      </p>
                    </div>
                  ) : undefined}
                  emptyMessage={isSuggestion ? "Cannot show reply threads. Process suggestions in the doc." : undefined}
                />
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

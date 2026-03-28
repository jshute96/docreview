"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import type { CommentThread } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { highlightText, highlightHtml } from "@/lib/highlight";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";
import { FriendlyDate } from "@/components/friendly-date";

/** Render comment/reply text with search highlighting, preferring htmlContent. */
function CommentContent({ htmlContent, content, searchFilter, className }: {
  htmlContent?: string;
  content: string;
  searchFilter: string;
  className: string;
}) {
  if (htmlContent) {
    const highlighted = highlightHtml(htmlContent, searchFilter);
    if (highlighted != null)
      return <p className={`${className} [&_a]:text-blue-600 [&_a]:underline`} dangerouslySetInnerHTML={{ __html: highlighted }} />;
    // Search matched plain text but not HTML text segments — fall back
    const plainHighlighted = highlightText(content, searchFilter);
    if (plainHighlighted !== content)
      return <p className={className}>{plainHighlighted}</p>;
    // No match anywhere — show formatted HTML
    return <p className={`${className} [&_a]:text-blue-600 [&_a]:underline`} dangerouslySetInnerHTML={{ __html: htmlContent }} />;
  }
  return content ? <p className={className}>{highlightText(content, searchFilter)}</p> : null;
}

interface CommentThreadPanelProps {
  threads: CommentThread[];
  loading: boolean;
  resolved?: boolean;
  commentUrl?: string;
  openTarget?: string;
  onOpenClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onReply?: (content: string) => Promise<void>;
  onResolve?: (content: string) => Promise<void>;
  onReopen?: (content: string) => Promise<void>;
  onReplyAndArchive?: (content: string) => Promise<void>;
  onArchive?: () => void;
  isArchived?: boolean;
  onToggleRead?: () => void;
  isRead?: boolean;
  onMute?: () => void;
  isMuted?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  searchFilter?: string;
  documentText?: string;
  isSelected?: boolean;
  onSelectInDoc?: () => void;
  /** Ref to the buttons row, used by CommentRow for auto-scroll positioning
   *  when this comment is selected from the Google Doc tab. */
  buttonsRowRef?: React.RefObject<HTMLDivElement | null>;
}

export function CommentThreadPanel({
  threads,
  loading,
  resolved,
  commentUrl,
  openTarget,
  onOpenClick,
  onRefresh,
  refreshing,
  onReply,
  onResolve,
  onReopen,
  onReplyAndArchive,
  onArchive,
  isArchived,
  onToggleRead,
  isRead,
  onMute,
  isMuted,
  onDirtyChange,
  searchFilter,
  documentText,
  isSelected,
  onSelectInDoc,
  buttonsRowRef,
}: CommentThreadPanelProps) {
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const prevDirtyRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const replyContainerRef = useRef<HTMLDivElement>(null);

  // Notify parent when dirty state changes
  const isDirty = replyText.trim().length > 0;
  useEffect(() => {
    if (isDirty !== prevDirtyRef.current) {
      prevDirtyRef.current = isDirty;
      onDirtyChange?.(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  // Warn before closing/navigating away with unsaved reply
  useEffect(() => {
    if (!isDirty) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measure = measureRef.current;
    const container = replyContainerRef.current;
    if (!textarea || !measure || !container) return;

    // Measure single-line text width via hidden span (read value from DOM, not state)
    measure.textContent = textarea.value || "";
    const textWidth = measure.getBoundingClientRect().width;
    const containerWidth = container.clientWidth;
    const minWidth = containerWidth * 0.25;
    const padding = 26; // horizontal padding + border
    const targetWidth = Math.max(minWidth, Math.min(textWidth + padding, containerWidth));
    textarea.style.width = targetWidth + "px";

    // Auto-grow height: save/restore scroll position to prevent scroll jumps
    const scrollParent = document.scrollingElement ?? document.documentElement;
    const scrollTop = scrollParent.scrollTop;
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
    scrollParent.scrollTop = scrollTop;
  }, []); // stable — reads value from DOM ref, no state deps

  useEffect(() => {
    resizeTextarea();
  }, [replyText, resizeTextarea]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recalculate on container resize (window resize, layout changes)
  useEffect(() => {
    const container = replyContainerRef.current;
    if (!container) return;
    // Only resize on width changes — resizeTextarea() itself changes height,
    // which would re-trigger the observer in an infinite loop.
    let prevWidth = container.clientWidth;
    const observer = new ResizeObserver(() => {
      const newWidth = container.clientWidth;
      if (newWidth !== prevWidth) {
        prevWidth = newWidth;
        resizeTextarea();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setReplyText(e.target.value);
  }

  async function handleReply() {
    if (!onReply || replyText.trim().length === 0) return;
    setSubmitting(true);
    try {
      await onReply(replyText.trim());
      setReplyText("");
    } catch {
      // Keep text on failure
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResolve() {
    if (!onResolve) return;
    setSubmitting(true);
    try {
      await onResolve(replyText.trim());
      setReplyText("");
    } catch {
      // Keep text on failure
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReplyAndArchive() {
    if (!onReplyAndArchive || replyText.trim().length === 0) return;
    setSubmitting(true);
    try {
      await onReplyAndArchive(replyText.trim());
      setReplyText("");
    } catch {
      // Keep text on failure
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReopen() {
    if (!onReopen) return;
    setSubmitting(true);
    try {
      await onReopen(replyText.trim());
      setReplyText("");
    } catch {
      // Keep text on failure
    } finally {
      setSubmitting(false);
    }
  }

  const replyBox = (
    <div ref={replyContainerRef} className="mt-3 pt-3 border-t border-zinc-200">
      {/* Hidden span mirrors textarea font to measure single-line text width */}
      <span
        ref={measureRef}
        className="fixed whitespace-pre text-sm"
        style={{ display: "inline-block", visibility: "hidden", left: "-9999px", top: "-9999px" }}
        aria-hidden="true"
      />
      <textarea
        ref={textareaRef}
        value={replyText}
        onChange={handleChange}
        placeholder="Reply..."
        rows={1}
        className={TEXTAREA_CLASSES}
        style={{ width: "25%", overflow: "hidden" }}
      />
      <div ref={buttonsRowRef} className="mt-2 flex items-center gap-2 whitespace-nowrap">
        {resolved ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title="Reopen this resolved comment"
            disabled={replyText.trim().length === 0 || submitting}
            onClick={handleReopen}
          >
            Reopen
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              title="Reply to this comment"
              disabled={replyText.trim().length === 0 || submitting}
              onClick={handleReply}
            >
              Reply
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              title="Mark this comment as resolved"
              disabled={submitting}
              onClick={handleResolve}
            >
              Resolve
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              title="Reply and archive this comment"
              disabled={replyText.trim().length === 0 || submitting}
              onClick={handleReplyAndArchive}
            >
              Reply &amp; Archive
            </Button>
          </>
        )}
        <span className="text-zinc-300 mx-1">|</span>
        {onArchive && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title={isArchived ? "Unhide this comment" : "Hide this comment"}
            onClick={onArchive}
          >
            {isArchived ? "Unarchive" : "Archive"}
          </Button>
        )}
        {onToggleRead && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title={isRead ? "Mark as unread" : "Mark as read"}
            onClick={onToggleRead}
          >
            {isRead ? "Mark unread" : "Mark read"}
          </Button>
        )}
        {onMute && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title={isMuted ? "Permanently hidden — click to unhide" : "Permanently hide this comment"}
            onClick={onMute}
          >
            {isMuted ? "Unmute" : "Mute"}
          </Button>
        )}
        <span className="text-zinc-300 mx-1">|</span>
        {commentUrl && (
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs" title="Open the document at this comment" asChild>
            <a href={commentUrl} target={openTarget ?? "_blank"} onClick={onOpenClick}>
              Open
            </a>
          </Button>
        )}
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title="Refresh this thread"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
        <p className="text-sm text-zinc-400">Loading comments...</p>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
        <p className="text-sm text-zinc-400">No comments on this document.</p>
        {replyBox}
      </div>
    );
  }

  return (
    <div className={`mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4${isSelected ? " ring-2 ring-blue-400" : ""}`}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- click to select comment in Google Doc */}
      <div className={`divide-y divide-zinc-200${onSelectInDoc ? " cursor-pointer" : ""}`} onClick={onSelectInDoc} title={onSelectInDoc ? "Click to select this comment in the document" : undefined}>
        {threads.map((thread, threadIndex) => (
          <div
            key={thread.id}
            className={`py-3 first:pt-0 last:pb-0 ${thread.resolved ? "opacity-60" : ""}`}
          >
            <div className={thread.fromMe ? "bg-green-50 -mx-4 px-4 pt-2 pb-1 mb-2" : ""}>
              {threadIndex === 0 && thread.quotedFileContent?.value && (
                <div className="mb-2">
                  <div className="rounded border-l-2 border-zinc-300 bg-zinc-100 px-3 py-1.5">
                    {/* Drive returns text/html for quotedFileContent but in practice
                       the value appears to be plain text with no formatting markup. */}
                    {thread.quotedFileContent.mimeType === "text/html" ? (
                      <p className="text-xs text-zinc-500 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: thread.quotedFileContent.value }} />
                    ) : (
                      <p className="text-xs text-zinc-500 whitespace-pre-wrap">{thread.quotedFileContent.value}</p>
                    )}
                  </div>
                  {documentText !== undefined && (() => {
                    // Drive API may truncate long quoted text with "..." or "…" — match on the prefix
                    const raw = thread.quotedFileContent!.value;
                    const trimmed = raw.replace(/\.{3}$|…$/, "");
                    return !documentText.toLowerCase().includes(trimmed.toLowerCase());
                  })() && (
                    <p
                      className="mt-1 text-xs text-amber-600"
                      title="The quoted text is a snapshot from when the comment was created. If the text has been deleted, the comment thread may not be visible when viewing the document."
                    >
                      This text no longer exists in the document. This comment might not be visible.
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-900">
                  {thread.author}
                </span>
                <FriendlyDate date={thread.createdTime} className="text-xs text-zinc-400" />
              </div>
              <CommentContent htmlContent={thread.htmlContent} content={thread.content} searchFilter={searchFilter ?? ""} className="mt-1 text-sm text-zinc-700 whitespace-pre-wrap" />
            </div>

            {thread.replies.map((reply, i) => (
              <div key={i} className={`mt-2 ml-8 ${reply.fromMe ? "bg-green-50 -mr-4 pr-4 pt-2 pb-1" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900">
                    {reply.author}
                  </span>
                  <FriendlyDate date={reply.createdTime} className="text-xs text-zinc-400" />
                  {reply.action === "resolve" && (
                    <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-zinc-600">
                      Resolved
                    </span>
                  )}
                  {reply.action === "reopen" && (
                    <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                      Reopened
                    </span>
                  )}
                </div>
                <CommentContent htmlContent={reply.htmlContent} content={reply.content} searchFilter={searchFilter ?? ""} className="mt-0.5 text-sm text-zinc-700 whitespace-pre-wrap" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {replyBox}
    </div>
  );
}

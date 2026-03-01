"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import type { CommentThread } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { highlightText, highlightHtml } from "@/lib/highlight";
import { TEXTAREA_CLASSES } from "@/lib/textarea-styles";

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

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface CommentThreadPanelProps {
  threads: CommentThread[];
  loading: boolean;
  resolved?: boolean;
  commentUrl?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onReply?: (content: string) => Promise<void>;
  onResolve?: (content: string) => Promise<void>;
  onReopen?: (content: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  searchFilter?: string;
}

export function CommentThreadPanel({
  threads,
  loading,
  resolved,
  commentUrl,
  onRefresh,
  refreshing,
  onReply,
  onResolve,
  onReopen,
  onDirtyChange,
  searchFilter,
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

    // Measure single-line text width via hidden span
    measure.textContent = replyText || "";
    const textWidth = measure.getBoundingClientRect().width;
    const containerWidth = container.clientWidth;
    const minWidth = containerWidth * 0.25;
    const padding = 26; // horizontal padding + border
    const targetWidth = Math.max(minWidth, Math.min(textWidth + padding, containerWidth));
    textarea.style.width = targetWidth + "px";

    // Auto-grow height for wrapped text
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  }, [replyText]);

  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  // Recalculate on container resize (window resize, layout changes)
  useEffect(() => {
    const container = replyContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => resizeTextarea());
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

  const hasButtons = commentUrl || onRefresh;

  const buttons = hasButtons ? (
    <div className="float-right relative z-10 flex gap-1 ml-2 mb-1">
      {commentUrl && (
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="Open the document at this comment" asChild>
          <a href={commentUrl} target="docreview-doc">
            Open
          </a>
        </Button>
      )}
      {onRefresh && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          title="Refresh this thread"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      )}
    </div>
  ) : null;

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
      <div className="mt-2 flex gap-2">
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
          </>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
        {buttons}
        <p className="text-sm text-zinc-400">Loading comments...</p>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
        {buttons}
        <p className="text-sm text-zinc-400">No comments on this document.</p>
        {replyBox}
      </div>
    );
  }

  return (
    <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4">
      {buttons}
      <div className="divide-y divide-zinc-200">
        {threads.map((thread, threadIndex) => (
          <div
            key={thread.id}
            className={`py-3 first:pt-0 last:pb-0 ${thread.resolved ? "opacity-60" : ""}`}
          >
            {threadIndex === 0 && thread.quotedFileContent?.value && (
              <div className="mb-2 rounded border-l-2 border-zinc-300 bg-zinc-100 px-3 py-1.5">
                {/* Drive returns text/html for quotedFileContent but in practice
                   the value appears to be plain text with no formatting markup. */}
                {thread.quotedFileContent.mimeType === "text/html" ? (
                  <p className="text-xs text-zinc-500 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: thread.quotedFileContent.value }} />
                ) : (
                  <p className="text-xs text-zinc-500 whitespace-pre-wrap">{thread.quotedFileContent.value}</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-900">
                {thread.author}
              </span>
              <span className="text-xs text-zinc-400">
                {formatTime(thread.createdTime)}
              </span>
              {thread.resolved && (
                <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-zinc-600">
                  Resolved
                </span>
              )}
            </div>
            <CommentContent htmlContent={thread.htmlContent} content={thread.content} searchFilter={searchFilter ?? ""} className="mt-1 text-sm text-zinc-700 whitespace-pre-wrap" />

            {thread.replies.map((reply, i) => (
              <div key={i} className="ml-8 mt-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900">
                    {reply.author}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {formatTime(reply.createdTime)}
                  </span>
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

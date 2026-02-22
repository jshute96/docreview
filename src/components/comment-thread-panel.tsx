"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import type { CommentThread } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";

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
  commentUrl?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function CommentThreadPanel({
  threads,
  loading,
  commentUrl,
  onRefresh,
  refreshing,
}: CommentThreadPanelProps) {
  const [replyText, setReplyText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const replyContainerRef = useRef<HTMLDivElement>(null);

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

  const hasButtons = commentUrl || onRefresh;

  const buttons = hasButtons ? (
    <div className="float-right flex gap-1 ml-2 mb-1">
      {commentUrl && (
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" asChild>
          <a href={commentUrl} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </Button>
      )}
      {onRefresh && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
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
        className="block resize-none rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-300"
        style={{ width: "25%", overflow: "hidden" }}
      />
      <div className="mt-2 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={replyText.trim().length === 0}
        >
          Reply
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs"
        >
          Resolve
        </Button>
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
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`py-3 first:pt-0 last:pb-0 ${thread.resolved ? "opacity-60" : ""}`}
          >
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
            <p className="mt-1 text-sm text-zinc-700 whitespace-pre-wrap">
              {thread.content}
            </p>

            {thread.replies.map((reply, i) => (
              <div key={i} className="ml-8 mt-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900">
                    {reply.author}
                  </span>
                  <span className="text-xs text-zinc-400">
                    {formatTime(reply.createdTime)}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-zinc-700 whitespace-pre-wrap">
                  {reply.content}
                </p>
              </div>
            ))}
          </div>
        ))}
      </div>
      {replyBox}
    </div>
  );
}

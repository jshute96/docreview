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
  const hasButtons = commentUrl || onRefresh;

  const buttons = hasButtons ? (
    <div className="flex justify-end gap-1 mb-2">
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
      </div>
    );
  }

  return (
    <div className="mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4 max-h-96 overflow-y-auto">
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
    </div>
  );
}

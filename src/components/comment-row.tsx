"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Comment } from "@prisma/client";
import { Button } from "@/components/ui/button";

interface CommentRowProps {
  comment: Comment;
  docId: string;
  driveUrl: string;
  content?: string;
  onUpdate: (updated: Comment) => void;
}

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function splitContent(raw: string): { author: string | null; text: string } {
  const sep = raw.indexOf(": ");
  if (sep === -1) return { author: null, text: raw };
  return { author: raw.slice(0, sep), text: raw.slice(sep + 2) };
}

export function CommentRow({ comment, docId, driveUrl, content, onUpdate }: CommentRowProps) {
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  function openInDoc() {
    const url = new URL(driveUrl);
    url.searchParams.set("disco", comment.googleCommentId);
    window.open(url.toString(), "docreview-comment-window");
    // This intends to prevent focusing the newly opened window, or raising the
    // existing over top of the doc-review window.
    // Unforutnately, it doesn't work in chrome.
    window.focus();
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

  const cellPy = content ? "pt-1.5 pb-0" : "py-1.5";
  const { author, text } = content ? splitContent(content) : { author: null, text: "" };
  const rowBg = hovered ? "bg-zinc-50" : "";
  const hoverHandlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };

  return (
    <>
    <tr
      className={`${rowBg} transition-colors cursor-pointer${content ? "" : " border-b border-zinc-100"}`}
      onClick={openInDoc}
      {...hoverHandlers}
    >
      <td className={`${cellPy} pl-4 pr-4 text-sm text-zinc-500 whitespace-nowrap`}>
        {formatDate(comment.driveCreatedAt)}
      </td>
      <td className={`${cellPy} pr-4 text-sm text-zinc-500 whitespace-nowrap`}>
        {sameAsCreated ? "—" : formatDate(comment.driveModifiedAt)}
      </td>
      <td className={`${cellPy} pr-4 text-sm text-zinc-500 tabular-nums`}>
        {comment.replyCount > 0 ? comment.replyCount : ""}
      </td>
      <td className={`${cellPy} pr-4`}>
        {comment.isMine && (
          <span className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700">
            Mine
          </span>
        )}
      </td>
      <td className={`${cellPy} pr-4`}>
        {comment.iParticipated && (
          <span className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700">
            Replied
          </span>
        )}
      </td>
      <td className={`${cellPy} pr-4`}>
        {comment.resolved ? (
          <span className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500">
            Resolved
          </span>
        ) : (
          <span className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
            Open
          </span>
        )}
      </td>
      <td className={`${cellPy} pr-4`}>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => updateStatus(isArchived ? "ACTIVE" : "ARCHIVED")}
            disabled={loading}
          >
            {isArchived ? "Unarchive" : "Archive"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => updateStatus(isMuted ? "ACTIVE" : "MUTED")}
            disabled={loading}
          >
            {isMuted ? "Unmute" : "Mute"}
          </Button>
        </div>
      </td>
    </tr>
    {content && (
      <tr
        className={`${rowBg} border-b border-zinc-100 transition-colors cursor-pointer`}
        onClick={openInDoc}
        {...hoverHandlers}
      >
        <td colSpan={7} className="pt-0.5 pb-2 pl-4 pr-4 max-w-0 overflow-hidden">
          <p className="truncate text-sm text-zinc-400">
            {author && <span className="text-zinc-600">{author}: </span>}
            {text}
          </p>
        </td>
      </tr>
    )}
    </>
  );
}

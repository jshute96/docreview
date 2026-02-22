"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Comment } from "@prisma/client";
import type { SuggestionContent } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

interface CommentRowProps {
  comment: Comment;
  docId: string;
  driveUrl: string;
  content?: string;
  suggestionContent?: SuggestionContent;
  onUpdate: (updated: Comment) => void;
}

function splitContent(raw: string): { author: string | null; text: string } {
  const sep = raw.indexOf(": ");
  if (sep === -1) return { author: null, text: raw };
  return { author: raw.slice(0, sep), text: raw.slice(sep + 2) };
}

export function CommentRow({ comment, docId, driveUrl, content, suggestionContent, onUpdate }: CommentRowProps) {
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  function openInDoc() {
    const url = new URL(driveUrl);
    url.searchParams.set("disco", comment.googleCommentId);
    window.open(url.toString(), "docreview-comment-window");
    // This intends to prevent focusing the newly opened window, or raising the
    // existing over top of the doc-review window.
    // Unfortunately, it doesn't work in Chrome.
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
  const isSuggestion = comment.type === "SUGGESTION";

  const sameAsCreated =
    comment.driveCreatedAt &&
    comment.driveModifiedAt &&
    new Date(comment.driveCreatedAt).getTime() === new Date(comment.driveModifiedAt).getTime();

  const hasContentRow = isSuggestion ? (!!suggestionContent || comment.resolved) : !!content;
  const cellPy = hasContentRow ? "pt-1.5 pb-0" : "py-1.5";
  const { author, text } = content ? splitContent(content) : { author: null, text: "" };
  const rowBg = hovered ? "bg-zinc-50" : "";
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
      className={`${rowBg} transition-colors cursor-pointer${hasContentRow ? "" : " border-b border-zinc-100"}`}
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
        {!isSuggestion && comment.isMine && (
          <span className="inline-flex rounded px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700">
            Mine
          </span>
        )}
      </td>
      <td className={`${cellPy} pr-4`}>
        {!isSuggestion && comment.iParticipated && (
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
    {hasContentRow && (
      <tr
        className={`${rowBg} border-b border-zinc-100 transition-colors cursor-pointer`}
        onClick={openInDoc}
        {...hoverHandlers}
      >
        <td colSpan={7} className="pt-0.5 pb-2 pl-4 pr-4 max-w-0 overflow-hidden">
          {isSuggestion && !suggestionContent && comment.resolved ? (
            <p className="truncate text-sm text-zinc-400 italic">Resolved suggestion</p>
          ) : isSuggestion && suggestionContent ? (
            <p className="truncate text-sm text-zinc-400">
              <span className="text-zinc-500">{suggestionLabel}: </span>
              {(comment.suggestionType === "EDIT" || comment.suggestionType === "DELETE") && (
                <span className="line-through text-red-400">{suggestionContent.deletedText}</span>
              )}
              {comment.suggestionType === "EDIT" && (
                <span className="text-zinc-400"> → </span>
              )}
              {(comment.suggestionType === "EDIT" || comment.suggestionType === "INSERT") && (
                <span className="text-zinc-600">{suggestionContent.insertedText}</span>
              )}
            </p>
          ) : (
            <p className="truncate text-sm text-zinc-400">
              {author && <span className="text-zinc-600">{author}: </span>}
              {text}
            </p>
          )}
        </td>
      </tr>
    )}
    </>
  );
}

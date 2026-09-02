"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import type { CommentThread } from "@/lib/google-drive";
import { Button } from "@/components/ui/button";
import { HamburgerButton } from "@/components/hamburger-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { highlightText, highlightHtml } from "@/lib/highlight";
import { sanitizeHtml } from "@/lib/sanitize-html";
import { cn } from "@/lib/utils";
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
      return <p className={`${className} [&_a]:text-blue-600 [&_a]:underline`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlighted) }} />;
    // Search matched plain text but not HTML text segments — fall back
    const plainHighlighted = highlightText(content, searchFilter);
    if (plainHighlighted !== content)
      return <p className={className}>{plainHighlighted}</p>;
    // No match anywhere — show formatted HTML
    return <p className={`${className} [&_a]:text-blue-600 [&_a]:underline`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(htmlContent) }} />;
  }
  return content ? <p className={className}>{highlightText(content, searchFilter)}</p> : null;
}

/** Hamburger menu shown on entries the user wrote, offering Edit and Delete. */
function EntryMenu({ label, onEdit, onDelete }: {
  label: string;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <HamburgerButton
          size="mini"
          title={`Edit or delete this ${label}`}
          // The enclosing thread box selects the comment in the Google Doc tab
          // when clicked; opening the menu shouldn't also trigger that.
          onClick={(e) => e.stopPropagation()}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {onEdit && (
          <DropdownMenuItem onSelect={onEdit} title={`Edit the text of this ${label}`}>
            Edit
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem onSelect={onDelete} title={`Delete this ${label}`}>
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** In-place editor replacing an entry's text while it is being edited. The
 *  caller keeps it open until the save round-trips, so the reader never sees
 *  stale text presented as saved. */
function EntryEditor({ value, onChange, onSave, onCancel, saving, error }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Open at the height of the text being edited — the entry was fully visible
  // before the click, so the box should be about the same size — then grow with
  // it as the user types. Scroll position is saved and restored because setting
  // height to "auto" briefly collapses the box and shifts the page.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const scrollParent = document.scrollingElement ?? document.documentElement;
    const scrollTop = scrollParent.scrollTop;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
    scrollParent.scrollTop = scrollTop;
  }, [value]);

  return (
    // Swallows clicks so interacting with the editor doesn't also select the
    // comment in the Google Doc tab.
    <div className="mt-1" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        disabled={saving}
        autoFocus
        className={`${TEXTAREA_CLASSES} w-full`}
        style={{ overflow: "hidden" }}
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs"
          title="Save this edit"
          disabled={saving || value.trim().length === 0}
          onClick={onSave}
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs"
          title="Discard this edit"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {saving && <span className="text-xs text-zinc-500">Saving...</span>}
        {!saving && error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}

/** Which control is holding unsaved text. */
export type DirtyKind = "reply" | "edit";

interface CommentThreadPanelProps {
  threads: CommentThread[];
  loading: boolean;
  resolved?: boolean;
  commentUrl?: string;
  openLabel?: string;
  openTitle?: string;
  openTarget?: string;
  onOpenClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  refreshTitle?: string;
  onReply?: (content: string) => Promise<void>;
  onResolve?: (content: string) => Promise<void>;
  onReopen?: (content: string) => Promise<void>;
  onReplyAndArchive?: (content: string) => Promise<void>;
  /** Edit an entry the user wrote. `replyId` is null for the thread's first
   *  comment. Must not resolve until the new content has been read back, and
   *  must reject with a user-readable message on failure. Omit to hide the
   *  edit/delete menu entirely (e.g. for suggestions). */
  onEditEntry?: (threadId: string, replyId: string | null, content: string) => Promise<void>;
  /** Delete an entry the user wrote. `replyId` null deletes the whole thread. */
  onDeleteEntry?: (threadId: string, replyId: string | null) => Promise<void>;
  onArchive?: () => void;
  isArchived?: boolean;
  onToggleRead?: () => void;
  isRead?: boolean;
  /** How many messages of the first thread (head comment + replies, in order)
   *  the user has read. Messages from this index on are marked unread. */
  readMessageCount: number;
  /** Sets the read point of the first thread to an absolute message count
   *  (0 = nothing read). Omit to hide the per-message read-point controls. */
  onSetReadCount?: (count: number) => void;
  /** Disables the read-point controls while a write or its preceding sync is in
   *  flight, so a second click can't race the first. */
  readPointDisabled?: boolean;
  onMute?: () => void;
  isMuted?: boolean;
  /** Reports unsaved work. `kind` says which control holds it, so the parent can
   *  tell the user what to clear. */
  onDirtyChange?: (dirty: boolean, kind?: DirtyKind) => void;
  searchFilter?: string;
  documentText?: string;
  isSelected?: boolean;
  onSelectInDoc?: () => void;
  /** Content rendered above the first thread entry (e.g., suggestion summary). */
  headerContent?: React.ReactNode;
  /** Content rendered below threads, above buttons (e.g., hint for synthesized suggestion threads). */
  footerContent?: React.ReactNode;
  /** Message shown when threads is empty. Defaults to "No comments on this document." */
  emptyMessage?: string;
  /** Whether this is a suggestion (vs a comment). Used for display labels. */
  isSuggestion?: boolean;
  /** Ref to the buttons row, used by CommentRow for auto-scroll positioning
   *  when this comment is selected from the Google Doc tab. */
  buttonsRowRef?: React.RefObject<HTMLDivElement | null>;
}

// Unread messages get a blue rail on their left edge. The rail's 2px plus its
// padding replace the same amount of existing margin/padding so text stays
// aligned with read messages. Green ("by me") is a background and the rail is
// a border, so the two can coexist on one message.
/** Blue left rail marking an unread message. Its 2px border plus 8px padding
 *  is offset by an equal negative margin, so railed and unrailed text line up.
 *  The rail goes on an inner element so the green "by me" background keeps its
 *  own edge, and the two cues can show on the same message. */
const railClass = (unread: boolean) =>
  unread ? "border-l-2 border-blue-400 -ml-[10px] pl-2" : "";

/** Moves the read/unread boundary to this message. The message itself is always
 *  included: on an unread message everything from here up becomes read, on a
 *  read message everything from here down becomes unread. Hidden until the
 *  message is hovered, so it stays out of the way of the text.
 *
 *  Wears the same Mark read/unread wording as the whole-thread button in the
 *  footer, since it does the same thing to a narrower range. Blue ties it to
 *  the rest of the unread marking; the outline box matches the `HamburgerButton`
 *  it can sit next to on the same author line, a step taller to fit the text.
 *
 *  The label alone repeats on every message, so the accessible name carries the
 *  position too — otherwise a screen reader announces N identical buttons. */
function ReadPointButton({ unread, disabled, position, total, onClick }: {
  unread: boolean;
  disabled?: boolean;
  /** 1-based position of this message in the thread. */
  position: number;
  /** How many messages the panel is showing for the thread. */
  total: number;
  onClick: () => void;
}) {
  const label = unread ? "Mark read" : "Mark unread";
  return (
    // The reveal lives on this wrapper, not on the button: `Button` carries
    // `disabled:opacity-50`, which outranks an `opacity-0` on the same element,
    // so while a write is in flight every hidden control in the thread would
    // fade halfway in. Hiding the wrapper keeps them out of sight whatever
    // state the button is in.
    //
    // focus-within, not focus: a mouse click focuses the button, and plain
    // `focus:` would leave it showing on a message the pointer has since left,
    // so two would be visible at once. Keyboard focus still reveals it.
    <span className="inline-flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <Button
        type="button"
        variant="outline"
        size="sm"
        title={unread
          ? "Mark this message and everything above it read"
          : "Mark this message and everything below it unread"}
        aria-label={unread
          ? `${label} through message ${position} of ${total}`
          : `${label} from message ${position} of ${total}`}
        disabled={disabled}
        // Sits inline after the date rather than out at the right edge, so it
        // stays next to the message it acts on even on a wide panel.
        className="h-5 px-1.5 text-xs font-normal text-blue-600"
        // The enclosing thread box selects the comment in the Google Doc tab when
        // clicked; moving the read point shouldn't also trigger that.
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      >
        {label}
      </Button>
    </span>
  );
}

export function CommentThreadPanel({
  threads,
  loading,
  resolved,
  commentUrl,
  openLabel,
  openTitle,
  openTarget,
  onOpenClick,
  onRefresh,
  refreshing,
  refreshDisabled,
  refreshTitle,
  onReply,
  onResolve,
  onReopen,
  onReplyAndArchive,
  onEditEntry,
  onDeleteEntry,
  onArchive,
  isArchived,
  onToggleRead,
  isRead,
  readMessageCount,
  onSetReadCount,
  readPointDisabled,
  onMute,
  isMuted,
  onDirtyChange,
  searchFilter,
  documentText,
  isSelected,
  onSelectInDoc,
  headerContent,
  footerContent,
  emptyMessage,
  isSuggestion,
  buttonsRowRef,
}: CommentThreadPanelProps) {
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Which entry is being edited, keyed by thread + reply (null replyId = the
  // thread's first comment). Only one entry is editable at a time.
  const [editing, setEditing] = useState<{ threadId: string; replyId: string | null } | null>(null);

  // Read markers apply to the first thread only — that's the one the stored
  // count belongs to. Message index 0 is the head comment, reply i is i + 1.
  const isUnread = (threadIndex: number, messageIndex: number) =>
    threadIndex === 0 && messageIndex >= readMessageCount;
  const authorWeight = (unread: boolean) => (unread ? "font-bold" : "font-medium");
  /** The read-point control for one message, on the first thread only. Clicking
   *  an unread message reads through it (count = index + 1); clicking a read one
   *  makes it the first unread message (count = index). Both ends are offered:
   *  the head comment sets the thread fully unread, the last message fully read. */
  const readPointButton = (threadIndex: number, messageIndex: number, thread: CommentThread) => {
    if (threadIndex !== 0 || !onSetReadCount) return null;
    const unread = isUnread(threadIndex, messageIndex);
    return (
      <ReadPointButton
        unread={unread}
        disabled={readPointDisabled}
        position={messageIndex + 1}
        total={thread.replies.length + 1}
        onClick={() => onSetReadCount(unread ? messageIndex + 1 : messageIndex)}
      />
    );
  };
  /** The "N unread" rule drawn above the first unread message. Returns null
   *  above the head comment, since a divider needs a read part above it to
   *  separate from, and on a fully-read thread, where no index matches.
   *
   *  The count here comes from the live thread, while the table's Unread column
   *  comes from the stored `replyCount`. The two can differ briefly when the
   *  thread has been refreshed from Drive but the row hasn't been re-synced. */
  const unreadDivider = (threadIndex: number, messageIndex: number, thread: CommentThread) => {
    if (threadIndex !== 0 || messageIndex === 0) return null;
    if (messageIndex !== readMessageCount) return null;
    const n = thread.replies.length + 1 - readMessageCount;
    return (
      <div className="mt-3 mb-1 flex items-center gap-2" title="Messages below this line are unread">
        {/* 1:2 split puts the label a third of the way across, so it stays
            near the text on short comments instead of far out to the right. */}
        <hr className="flex-1 border-blue-300" />
        <span className="text-xs font-medium text-blue-600">{n} unread</span>
        <hr className="flex-[2] border-blue-300" />
      </div>
    );
  };
  const [editText, setEditText] = useState("");
  // The text the editor opened with, so an untouched editor doesn't count as
  // unsaved work.
  const [editOriginal, setEditOriginal] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ threadId: string; replyId: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const prevDirtyRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const replyContainerRef = useRef<HTMLDivElement>(null);

  // Notify parent when dirty state changes. A changed editor counts as dirty so
  // an in-progress edit gets the same unsaved-work warnings as a typed reply —
  // but merely opening the editor doesn't, any more than an empty reply box does.
  const editDirty = editing !== null && editText.trim() !== editOriginal.trim();
  const isDirty = replyText.trim().length > 0 || editDirty;
  const dirtyKind: DirtyKind = replyText.trim().length > 0 ? "reply" : "edit";
  useEffect(() => {
    if (isDirty !== prevDirtyRef.current) {
      prevDirtyRef.current = isDirty;
      onDirtyChange?.(isDirty, isDirty ? dirtyKind : undefined);
    }
  }, [isDirty, dirtyKind, onDirtyChange]);

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

  function startEdit(threadId: string, replyId: string | null, content: string) {
    setEditing({ threadId, replyId });
    setEditText(content);
    setEditOriginal(content);
    setEditError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setEditText("");
    setEditOriginal("");
    setEditError(null);
  }

  // The entry being edited or deleted can disappear underneath us — another tab
  // or a background refresh replaces `threads`. Without this the editor unmounts
  // but `editing` stays set, leaving the row permanently "unsaved" and
  // un-collapsible, and a stale confirm dialog would delete a missing entry.
  useEffect(() => {
    const stillPresent = (entry: { threadId: string; replyId: string | null }) => {
      const thread = threads.find((t) => t.id === entry.threadId);
      if (!thread) return false;
      return entry.replyId === null || thread.replies.some((r) => r.id === entry.replyId);
    };
    if (editing && !stillPresent(editing)) cancelEdit();
    if (pendingDelete && !deleting && !stillPresent(pendingDelete)) {
      setPendingDelete(null);
      setDeleteError(null);
    }
  }, [threads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stays in edit mode on failure so the typed text isn't lost, and until
  // success so the entry only re-renders as text once the new content is live.
  async function saveEdit() {
    if (!onEditEntry || !editing || editText.trim().length === 0) return;
    setEditSaving(true);
    setEditError(null);
    try {
      await onEditEntry(editing.threadId, editing.replyId, editText.trim());
      setEditing(null);
      setEditText("");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save — please try again.");
    } finally {
      setEditSaving(false);
    }
  }

  async function confirmDelete() {
    if (!onDeleteEntry || !pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteEntry(pendingDelete.threadId, pendingDelete.replyId);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  const isEditing = (threadId: string, replyId: string | null) =>
    editing?.threadId === threadId && editing?.replyId === replyId;

  /** Entries the user wrote can be edited; replies without a Drive ID (synthesized
   *  from Gmail notifications or the extension) can't be addressed by the API. */
  const canModify = (fromMe: boolean, replyId: string | null) =>
    !!(onEditEntry || onDeleteEntry) && fromMe && replyId !== "";

  const deleteDialog = (
    <AlertDialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) {
          setPendingDelete(null);
          setDeleteError(null);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendingDelete?.replyId ? "Delete this reply?" : "Delete this comment?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pendingDelete?.replyId
              ? "This reply will be removed from the document. This can't be undone."
              : "This deletes the whole comment thread, including any replies, from the document. This can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            onClick={(e) => {
              // Keep the dialog open until the delete round-trips, so errors
              // are shown here rather than vanishing with the dialog.
              e.preventDefault();
              confirmDelete();
            }}
          >
            {deleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const replyBox = (
    <div ref={replyContainerRef} className="mt-3 pt-3 border-t border-zinc-200">
      {onReply && (
        <>
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
        </>
      )}
      {footerContent}
      {/* flex-wrap lets buttons wrap to a second row at narrow widths instead of
         overflowing the container. Don't use whitespace-nowrap or min-w-fit here —
         min-w-fit was tried earlier but it made the box stretch beyond 90% width
         when suggestion text was long. */}
      <div ref={buttonsRowRef} className={`${onReply ? "mt-2 " : ""}flex flex-wrap items-center gap-2`}>
        {onReply && (resolved ? (
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
        ))}
        {onReply && <span className="text-zinc-300 mx-1">|</span>}
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
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs" title={openTitle ?? "Open the document at this comment"} asChild>
            <a href={commentUrl} target={openTarget ?? "_blank"} onClick={onOpenClick}>
              {openLabel ?? "Open"}
            </a>
          </Button>
        )}
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs"
            title={refreshTitle ?? "Refresh this thread"}
            onClick={onRefresh}
            disabled={refreshing || refreshDisabled}
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
        {headerContent}
        <p className="text-sm text-zinc-400">{emptyMessage ?? "No comments on this document."}</p>
        {footerContent}
        {replyBox}
      </div>
    );
  }

  return (
    <div className={`mx-auto w-[90%] my-3 rounded-lg border bg-zinc-50 p-4${isSelected ? " ring-2 ring-blue-400" : ""}`}>
      {headerContent}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- click to select comment in Google Doc */}
      <div className={`divide-y divide-zinc-200${onSelectInDoc ? " cursor-pointer" : ""}`} onClick={onSelectInDoc}>
        {threads.map((thread, threadIndex) => (
          <div
            key={thread.id}
            className={`py-3 first:pt-0 last:pb-0 ${thread.resolved ? "opacity-60" : ""}`}
          >
            <div className={thread.fromMe ? "bg-green-50 -mx-4 px-4 pt-2 pb-1 mb-2" : ""}>
              {threadIndex === 0 && (() => {
                const typeLabel = isSuggestion ? "suggestion" : "comment";
                // Compute anchor text warning (at most one):
                // 1. Extension says content deleted → definitive orphaned warning
                // 2. Quoted text not found in document + extension says not deleted → text changed
                // 3. Quoted text not found in document + no extension data → uncertain warning
                let anchorWarning: string | undefined;
                let anchorWarningTitle: string | undefined;
                if (thread.originalContentDeleted && !(isSuggestion && resolved)) {
                  anchorWarning = `Original content deleted. This ${resolved && thread.quotedFileContent?.value ? "text" : typeLabel} is not visible in the document.`;
                } else if (!thread.originalContentDeleted && thread.quotedFileContent?.value && documentText !== undefined) {
                  const trimmed = thread.quotedFileContent.value.replace(/\.{3}$|…$/, "");
                  if (!documentText.toLowerCase().includes(trimmed.toLowerCase())) {
                    if (thread.originalContentDeleted === false) {
                      anchorWarning = `This was the original text when the ${typeLabel} was created.`;
                    } else {
                      anchorWarning = `This text no longer exists in the document. This ${typeLabel} might not be visible.`;
                      anchorWarningTitle = `The quoted text is a snapshot from when the ${typeLabel} was created. If the text has been deleted, the ${typeLabel} thread may not be visible when viewing the document.`;
                    }
                  }
                }
                return <>
                  {thread.quotedFileContent?.value && (
                    <div className="mb-2">
                      <div className="rounded border-l-2 border-zinc-300 bg-zinc-100 px-3 py-1.5">
                        {thread.quotedFileContent.mimeType === "text/html" ? (
                          <p className="text-xs text-zinc-500 whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: sanitizeHtml(thread.quotedFileContent.value) }} />
                        ) : (
                          <p className="text-xs text-zinc-500 whitespace-pre-wrap">{thread.quotedFileContent.value}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {anchorWarning && (
                    <p className="mb-2 text-xs text-amber-600" title={anchorWarningTitle}>{anchorWarning}</p>
                  )}
                </>;
              })()}
              {/* Rail wraps only the author line and text — not the quoted
                  document snippet above, which isn't a message. */}
              <div className={cn("group/msg", railClass(isUnread(threadIndex, 0)))}>
                <div className="flex items-center gap-2">
                  <span className={`text-sm ${authorWeight(isUnread(threadIndex, 0))} text-zinc-900`}>
                    {thread.author}
                  </span>
                  <FriendlyDate date={thread.createdTime} className="text-xs text-zinc-400" />
                  {canModify(thread.fromMe, null) && (
                    <EntryMenu
                      label="comment"
                      onEdit={onEditEntry && (() => startEdit(thread.id, null, thread.content))}
                      onDelete={onDeleteEntry && (() => setPendingDelete({ threadId: thread.id, replyId: null }))}
                    />
                  )}
                  {readPointButton(threadIndex, 0, thread)}
                </div>
                {isEditing(thread.id, null) ? (
                  <EntryEditor
                    value={editText}
                    onChange={setEditText}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    saving={editSaving}
                    error={editError}
                  />
                ) : (
                  <CommentContent htmlContent={thread.htmlContent} content={thread.content} searchFilter={searchFilter ?? ""} className="mt-1 text-sm text-zinc-700 whitespace-pre-wrap" />
                )}
              </div>
            </div>

            {thread.replies.map((reply, i) => {
              const unread = isUnread(threadIndex, i + 1);
              return (
                <div key={i}>
                  {unreadDivider(threadIndex, i + 1, thread)}
                  <div className={`mt-2 ml-8 ${reply.fromMe ? "bg-green-50 -mr-4 pr-4 pt-2 pb-1" : ""}`}>
                    <div className={cn("group/msg", railClass(unread))}>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${authorWeight(unread)} text-zinc-900`}>
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
                        {reply.action === "accept" && (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">
                            Accepted
                          </span>
                        )}
                        {reply.action === "reject" && (
                          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                            Rejected
                          </span>
                        )}
                        {/* Resolve/reopen markers carry no text of their own, so
                            there's nothing to edit on them. */}
                        {!reply.action && canModify(reply.fromMe, reply.id) && (
                          <EntryMenu
                            label="reply"
                            onEdit={onEditEntry && (() => startEdit(thread.id, reply.id, reply.content))}
                            onDelete={onDeleteEntry && (() => setPendingDelete({ threadId: thread.id, replyId: reply.id }))}
                          />
                        )}
                        {readPointButton(threadIndex, i + 1, thread)}
                      </div>
                      {isEditing(thread.id, reply.id) ? (
                        <EntryEditor
                          value={editText}
                          onChange={setEditText}
                          onSave={saveEdit}
                          onCancel={cancelEdit}
                          saving={editSaving}
                          error={editError}
                        />
                      ) : (
                        reply.content && <CommentContent htmlContent={reply.htmlContent} content={reply.content} searchFilter={searchFilter ?? ""} className="mt-0.5 text-sm text-zinc-700 whitespace-pre-wrap" />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {replyBox}
      {deleteDialog}
    </div>
  );
}

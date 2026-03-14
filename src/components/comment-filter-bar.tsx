"use client";

import type { TriState } from "@/lib/tri-state";
import { TriStateButton, type TriStateColorConfig } from "@/components/tri-state-button";
import { TriStateStarButton } from "@/components/star-button";
import { XIcon } from "@/components/x-icon";

const COMMENT_TRISTATE_COLORS: Record<string, TriStateColorConfig> = {
  mine: {
    off: "bg-blue-100 text-blue-700 ring-1 ring-blue-300 hover:bg-blue-200",
    include: "bg-blue-600 text-white ring-1 ring-blue-700",
    exclude: "bg-blue-100 text-blue-700 ring-1 ring-blue-300",
  },
  replied: {
    off: "bg-violet-100 text-violet-700 ring-1 ring-violet-300 hover:bg-violet-200",
    include: "bg-violet-600 text-white ring-1 ring-violet-700",
    exclude: "bg-violet-100 text-violet-700 ring-1 ring-violet-300",
  },
  assigned: {
    off: "bg-amber-100 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-200",
    include: "bg-amber-600 text-white ring-1 ring-amber-700",
    exclude: "bg-amber-100 text-amber-700 ring-1 ring-amber-300",
  },
  mentioned: {
    off: "bg-orange-100 text-orange-700 ring-1 ring-orange-300 hover:bg-orange-200",
    include: "bg-orange-600 text-white ring-1 ring-orange-700",
    exclude: "bg-orange-100 text-orange-700 ring-1 ring-orange-300",
  },
  resolved: {
    off: "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-300 hover:bg-zinc-200",
    include: "bg-zinc-600 text-white ring-1 ring-zinc-700",
    exclude: "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-300",
  },
  suggestions: {
    off: "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-300 hover:bg-zinc-200",
    include: "bg-zinc-600 text-white ring-1 ring-zinc-700",
    exclude: "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-300",
  },
  unread: {
    off: "bg-green-50 text-green-700 ring-1 ring-green-300 hover:bg-green-100",
    include: "bg-green-600 text-white ring-1 ring-green-700",
    exclude: "bg-green-50 text-green-700 ring-1 ring-green-300",
  },
};

type ShowMode = "inbox" | "open" | "resolved" | "all";
interface CommentFilterBarProps {
  mineFilter: TriState;
  repliedFilter: TriState;
  assignedFilter: TriState;
  mentionedFilter: TriState;
  showMine?: boolean;
  showReplied?: boolean;
  showAssigned?: boolean;
  showMentioned?: boolean;
  resolvedFilter: TriState;
  showMode: ShowMode;
  suggestionsFilter: TriState;
  isStarred: TriState;
  unreadFilter: TriState;
  searchFilter: string;
  onMineChange: (v: TriState) => void;
  onRepliedChange: (v: TriState) => void;
  onAssignedChange: (v: TriState) => void;
  onMentionedChange: (v: TriState) => void;
  onResolvedChange: (v: TriState) => void;
  onShowModeChange: (v: ShowMode) => void;
  onSuggestionsChange: (v: TriState) => void;
  onIsStarredChange: (v: TriState) => void;
  onUnreadChange: (v: TriState) => void;
  onSearchFilterChange: (v: string) => void;
}

export function CommentFilterBar({
  mineFilter,
  repliedFilter,
  assignedFilter,
  mentionedFilter,
  showMine = true,
  showReplied = true,
  showAssigned = true,
  showMentioned = true,
  resolvedFilter,
  showMode,
  suggestionsFilter,
  isStarred,
  unreadFilter,
  searchFilter,
  onMineChange,
  onRepliedChange,
  onAssignedChange,
  onMentionedChange,
  onResolvedChange,
  onShowModeChange,
  onSuggestionsChange,
  onIsStarredChange,
  onUnreadChange,
  onSearchFilterChange,
}: CommentFilterBarProps) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 px-4 py-2">
      <legend className="px-1 text-xs font-medium text-zinc-900 uppercase tracking-wide">
        Filters
      </legend>
      <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">

        <div className="flex flex-wrap items-center gap-2">
          {showMine && <TriStateButton label="Mine" value={mineFilter} onChange={onMineChange} colors={COMMENT_TRISTATE_COLORS.mine} title="Threads you started" className="rounded" />}
          {showReplied && <TriStateButton label="Replied" value={repliedFilter} onChange={onRepliedChange} colors={COMMENT_TRISTATE_COLORS.replied} title="Threads you replied in" className="rounded" />}
          {showAssigned && <TriStateButton label="Assigned" value={assignedFilter} onChange={onAssignedChange} colors={COMMENT_TRISTATE_COLORS.assigned} title="Comments assigned to you" className="rounded" />}
          {showMentioned && <TriStateButton label="@Mentioned" value={mentionedFilter} onChange={onMentionedChange} colors={COMMENT_TRISTATE_COLORS.mentioned} title="Threads where you were @mentioned" className="rounded" />}
          <TriStateButton label="Resolved" value={resolvedFilter} onChange={onResolvedChange} colors={COMMENT_TRISTATE_COLORS.resolved} title="Resolved comments" className="rounded" />
          <TriStateButton label="Unread" value={unreadFilter} onChange={onUnreadChange} colors={COMMENT_TRISTATE_COLORS.unread} title="Unread comments" className="rounded" />
        </div>
        <div className="h-4 w-px bg-zinc-200" />
        <TriStateStarButton value={isStarred} onChange={onIsStarredChange} />
        <div className="h-4 w-px bg-zinc-200" />
        <TriStateButton label="Suggestions" value={suggestionsFilter} onChange={onSuggestionsChange} colors={COMMENT_TRISTATE_COLORS.suggestions} title="Suggestions" className="rounded" />

        <div className="h-4 w-px bg-zinc-200" />

        <div className="flex items-center gap-2">
          {(["inbox", "open", "all"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onShowModeChange(mode)}
              title={{
                inbox: "Show inbox comments",
                open: "Show all unresolved comments",
                all: "Show all comments including resolved"
              }[mode]}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                showMode === mode
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-300 hover:bg-zinc-200"
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-400">Search</span>
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => onSearchFilterChange(e.target.value)}
          placeholder="regex filter…"
          className="rounded border border-zinc-200 bg-white pl-2 pr-5 py-0.5 text-xs text-zinc-700 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none w-90"
        />
        {searchFilter && (
          <button
            onClick={() => onSearchFilterChange("")}
            className="text-zinc-400 hover:text-zinc-600 -ml-6 mr-1"
            title="Clear search"
          >
            <XIcon />
          </button>
        )}
      </div>
      </div>
    </fieldset>
  );
}

"use client";

import type { TriState } from "@/lib/tri-state";
import { TriStateButton, type TriStateColorConfig } from "@/components/tri-state-button";
import { TriStateStarButton } from "@/components/star-button";
import { XIcon } from "@/components/x-icon";
import { CountChip } from "@/components/count-chip";
import { toneToggleClass, toneTriStateColors } from "@/lib/tones";
import {
  COUNTED_SHOW_MODES, badgeCountTooltip, modeCountTooltip,
  type BadgeKey, type FilterCounts, type ShowMode,
} from "@/lib/comment-filters";

/** Filter button colors, matching the badges they filter on (see `@/lib/tones`).
 *  Keyed by badge so a missing entry is a type error rather than a render crash. */
const COMMENT_TRISTATE_COLORS: Record<Exclude<BadgeKey, "starred">, TriStateColorConfig> = {
  mine: toneTriStateColors("blue"),
  replied: toneTriStateColors("violet"),
  assigned: toneTriStateColors("amber"),
  mentioned: toneTriStateColors("orange"),
  resolved: toneTriStateColors("grayDark"),
  deleted: toneTriStateColors("red"),
  suggestions: toneTriStateColors("gray"),
  unread: toneTriStateColors("green"),
};

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
  deletedFilter: TriState;
  /** Deleted state comes only from the browser extension, so the filter is
   *  shown only when at least one comment is known to be in that state. */
  showDeleted: boolean;
  showMode: ShowMode;
  suggestionsFilter: TriState;
  isStarred: TriState;
  unreadFilter: TriState;
  searchFilter: string;
  counts: FilterCounts;
  onMineChange: (v: TriState) => void;
  onRepliedChange: (v: TriState) => void;
  onAssignedChange: (v: TriState) => void;
  onMentionedChange: (v: TriState) => void;
  onResolvedChange: (v: TriState) => void;
  onDeletedChange: (v: TriState) => void;
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
  deletedFilter,
  showDeleted,
  showMode,
  suggestionsFilter,
  isStarred,
  unreadFilter,
  searchFilter,
  counts,
  onMineChange,
  onRepliedChange,
  onAssignedChange,
  onMentionedChange,
  onResolvedChange,
  onDeletedChange,
  onShowModeChange,
  onSuggestionsChange,
  onIsStarredChange,
  onUnreadChange,
  onSearchFilterChange,
}: CommentFilterBarProps) {
  const badgeTitle = (key: BadgeKey, base: string) =>
    [base, ...badgeCountTooltip(counts.badges[key], showMode)].join("\n");
  const badge = (key: Exclude<BadgeKey, "starred">, label: string, value: TriState, onChange: (v: TriState) => void, base: string) => {
    const title = badgeTitle(key, base);
    return (
      <TriStateButton
        label={label}
        value={value}
        onChange={onChange}
        colors={COMMENT_TRISTATE_COLORS[key]}
        title={title}
        className="rounded"
        suffix={<CountChip count={counts.badges[key].shown} filled={value === "include"} />}
      />
    );
  };

  return (
    <fieldset className="rounded-lg border border-zinc-200 px-4 py-2">
      <legend className="px-1 text-xs font-medium text-zinc-900 uppercase tracking-wide">
        Filters
      </legend>
      <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">

        <div className="flex flex-wrap items-center gap-2">
          {showMine && badge("mine", "Mine", mineFilter, onMineChange, "Comments you started")}
          {showReplied && badge("replied", "Replied", repliedFilter, onRepliedChange, "Comments you've replied to")}
          {showAssigned && badge("assigned", "Assigned", assignedFilter, onAssignedChange, "Comments assigned to you")}
          {showMentioned && badge("mentioned", "@Mentioned", mentionedFilter, onMentionedChange, "Comments where you were @mentioned")}
          {badge("resolved", "Resolved", resolvedFilter, onResolvedChange, "Resolved comments")}
          {showDeleted && badge("deleted", "Deleted", deletedFilter, onDeletedChange, "Comments on deleted text, not visible in the document")}
          {badge("unread", "Unread", unreadFilter, onUnreadChange, "Unread comments")}
          <TriStateStarButton
            value={isStarred}
            onChange={onIsStarredChange}
            title={badgeTitle("starred", "Starred comments")}
            suffix={<CountChip count={counts.badges.starred.shown} filled={isStarred === "include"} />}
          />
        </div>
        <div className="h-4 w-px bg-zinc-200" />
        {badge("suggestions", "Suggestions", suggestionsFilter, onSuggestionsChange, "Suggestions")}

        <div className="h-4 w-px bg-zinc-200" />

        <div className="flex items-center gap-2">
          {COUNTED_SHOW_MODES.map((mode) => {
            const title = [
              {
                inbox: "Show inbox comments",
                open: "Show all unresolved comments",
                all: "Show all comments including resolved"
              }[mode],
              ...modeCountTooltip(counts.modes[mode]),
            ].join("\n");
            return (
            <button
              key={mode}
              onClick={() => onShowModeChange(mode)}
              title={title}
              // Unselected matches the other gray filter buttons; selected stays
              // near-black since exactly one mode is always on.
              className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                showMode === mode
                  ? "bg-zinc-800 text-white ring-1 ring-zinc-900"
                  : toneToggleClass("gray", false)
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
              <CountChip count={counts.modes[mode].total} filled={showMode === mode} />
            </button>
            );
          })}
        </div>

      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-500">Search</span>
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => onSearchFilterChange(e.target.value)}
          title="Filter by regex or substring"
          placeholder="regex or substring…"
          className="rounded border border-zinc-200 bg-white pl-2 pr-5 py-0.5 text-xs text-zinc-700 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none w-90"
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

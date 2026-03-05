"use client";

import type { Label } from "@prisma/client";
import type { TriState } from "@/lib/tri-state";
import { DocTypeIcon } from "@/components/doc-type-icon";
import {
  TriStateButton,
  TriStateIconButton,
  TriStateLabelButton,
  TRISTATE_COLORS,
} from "@/components/tri-state-button";
import { TriStateStarButton } from "@/components/star-button";

const DOC_TYPES = [
  { mimeType: "application/vnd.google-apps.document", label: "Docs", color: "#4285F4" },
  { mimeType: "application/vnd.google-apps.spreadsheet", label: "Sheets", color: "#34A853" },
  { mimeType: "application/vnd.google-apps.presentation", label: "Slides", color: "#FBBC04" },
] as const;

interface FilterBarProps {
  labels: Label[];
  isInbox: TriState;
  hasComments: TriState;
  isAuthor: TriState;
  isStarred: TriState;
  mimeTypes: Record<string, TriState>;
  labelsFilter: Record<string, TriState>;
  titleFilter: string;
  onIsInboxChange: (v: TriState) => void;
  onHasCommentsChange: (v: TriState) => void;
  onIsAuthorChange: (v: TriState) => void;
  onIsStarredChange: (v: TriState) => void;
  onMimeTypeChange: (mimeType: string, v: TriState) => void;
  onLabelChange: (id: string, v: TriState) => void;
  onTitleFilterChange: (v: string) => void;
}

export function FilterBar({
  labels,
  isInbox,
  hasComments,
  isAuthor,
  isStarred,
  mimeTypes,
  labelsFilter,
  titleFilter,
  onIsInboxChange,
  onHasCommentsChange,
  onIsAuthorChange,
  onIsStarredChange,
  onMimeTypeChange,
  onLabelChange,
  onTitleFilterChange,
}: FilterBarProps) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 px-4 py-3">
      <legend className="px-1 text-xs font-medium text-zinc-900 uppercase tracking-wide">
        Filters
      </legend>
      <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">

        {/* Doc type icons */}
        <div className="flex items-center gap-1">
          {DOC_TYPES.map(({ mimeType, label, color }) => (
            <TriStateIconButton
              key={mimeType}
              value={mimeTypes[mimeType] ?? "off"}
              onChange={(v) => onMimeTypeChange(mimeType, v)}
              title={label}
              iconColor={color}
            >
              <DocTypeIcon mimeType={mimeType} className="h-4 w-4" />
            </TriStateIconButton>
          ))}
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Author */}
        <TriStateButton
          label="Author"
          value={isAuthor}
          onChange={onIsAuthorChange}
          colors={TRISTATE_COLORS.author}
          className="rounded-full"
          title="Docs that have the Author tag"
        />

        <div className="h-4 w-px bg-zinc-200" />

        {/* Starred */}
        <TriStateStarButton value={isStarred} onChange={onIsStarredChange} />

        <div className="h-4 w-px bg-zinc-200" />

        {/* Label badges */}
        <div className="flex flex-wrap items-center gap-1">
          {labels.map((label) => (
            <TriStateLabelButton
              key={label.labelId}
              label={label.name}
              color={label.color}
              value={labelsFilter[label.labelId] ?? "off"}
              onChange={(v) => onLabelChange(label.labelId, v)}
              title="Filter by label"
            />
          ))}
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Inbox */}
        <TriStateButton
          label="Inbox"
          value={isInbox}
          onChange={onIsInboxChange}
          colors={TRISTATE_COLORS.author}
          className="rounded"
          title="Inbox (unarchived) docs"
        />

        <div className="h-4 w-px bg-zinc-200" />

        {/* Comments */}
        <TriStateButton
          label="Comments"
          value={hasComments}
          onChange={onHasCommentsChange}
          colors={TRISTATE_COLORS.author}
          className="rounded"
          title="With open comments"
        />

      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-400">Search</span>
        <input
          type="text"
          value={titleFilter}
          onChange={(e) => onTitleFilterChange(e.target.value)}
          title="Filter by regular expression"
          placeholder="regex filter…"
          className="rounded border border-zinc-200 bg-white pl-2 pr-5 py-0.5 text-xs text-zinc-700 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none w-90"
        />
        {titleFilter && (
          <button
            onClick={() => onTitleFilterChange("")}
            className="text-zinc-400 hover:text-zinc-600 -ml-6 mr-1"
            title="Clear search"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
            </svg>
          </button>
        )}
      </div>
      </div>
    </fieldset>
  );
}

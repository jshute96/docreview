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

const DOC_TYPES = [
  { mimeType: "application/vnd.google-apps.document", label: "Docs", color: "#4285F4" },
  { mimeType: "application/vnd.google-apps.spreadsheet", label: "Sheets", color: "#34A853" },
  { mimeType: "application/vnd.google-apps.presentation", label: "Slides", color: "#FBBC04" },
] as const;

interface FilterBarProps {
  labels: Label[];
  isActive: TriState;
  hasComments: TriState;
  isAuthor: TriState;
  mimeTypes: Record<string, TriState>;
  labelsFilter: Record<string, TriState>;
  titleFilter: string;
  onIsActiveChange: (v: TriState) => void;
  onHasCommentsChange: (v: TriState) => void;
  onIsAuthorChange: (v: TriState) => void;
  onMimeTypeChange: (mimeType: string, v: TriState) => void;
  onLabelChange: (id: string, v: TriState) => void;
  onTitleFilterChange: (v: string) => void;
}

export function FilterBar({
  labels,
  isActive,
  hasComments,
  isAuthor,
  mimeTypes,
  labelsFilter,
  titleFilter,
  onIsActiveChange,
  onHasCommentsChange,
  onIsAuthorChange,
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
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">

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
        />

        <div className="h-4 w-px bg-zinc-200" />

        {/* Label badges */}
        <div className="flex flex-wrap items-center gap-1">
          {labels.map((label) => (
            <TriStateLabelButton
              key={label.id}
              label={label.name}
              color={label.color}
              value={labelsFilter[label.id] ?? "off"}
              onChange={(v) => onLabelChange(label.id, v)}
            />
          ))}
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Active */}
        <TriStateButton
          label="Active"
          value={isActive}
          onChange={onIsActiveChange}
          colors={TRISTATE_COLORS.author}
          className="rounded"
        />

        <div className="h-4 w-px bg-zinc-200" />

        {/* Comments */}
        <TriStateButton
          label="Comments"
          value={hasComments}
          onChange={onHasCommentsChange}
          colors={TRISTATE_COLORS.author}
          className="rounded"
        />

      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-900">Title</span>
        <input
          type="text"
          value={titleFilter}
          onChange={(e) => onTitleFilterChange(e.target.value)}
          placeholder="regex filter…"
          className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none w-90"
        />
      </div>
      </div>
    </fieldset>
  );
}

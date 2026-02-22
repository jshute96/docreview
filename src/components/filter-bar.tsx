"use client";

import type { Label } from "@prisma/client";
import { DocTypeIcon } from "@/components/doc-type-icon";
import { ROLE_COLORS } from "@/lib/role-colors";

const DOC_TYPES = [
  { mimeType: "application/vnd.google-apps.document", label: "Docs" },
  { mimeType: "application/vnd.google-apps.spreadsheet", label: "Sheets" },
  { mimeType: "application/vnd.google-apps.presentation", label: "Slides" },
] as const;

interface FilterBarProps {
  labels: Label[];
  showArchived: boolean;
  hasCommentsFilter: boolean;
  selectedLabelIds: string[];
  roleFilter: "AUTHOR" | "NOT_AUTHOR" | null;
  selectedMimeTypes: string[];
  onShowArchivedChange: (v: boolean) => void;
  onHasCommentsFilterChange: (v: boolean) => void;
  onLabelToggle: (id: string) => void;
  onRoleFilterChange: (role: "AUTHOR" | "NOT_AUTHOR" | null) => void;
  onMimeTypeToggle: (mimeType: string) => void;
}

export function FilterBar({
  labels,
  showArchived,
  hasCommentsFilter,
  selectedLabelIds,
  roleFilter,
  selectedMimeTypes,
  onShowArchivedChange,
  onHasCommentsFilterChange,
  onLabelToggle,
  onRoleFilterChange,
  onMimeTypeToggle,
}: FilterBarProps) {
  return (
    <fieldset className="rounded-lg border border-zinc-200 px-4 py-2">
      <legend className="px-1 text-xs font-medium text-zinc-400 uppercase tracking-wide">
        Filters
      </legend>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">

        {/* Doc type */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">Doc type</span>
          <div className="flex items-center gap-1">
            {DOC_TYPES.map(({ mimeType, label }) => {
              const active = selectedMimeTypes.includes(mimeType);
              return (
                <button
                  key={mimeType}
                  onClick={() => onMimeTypeToggle(mimeType)}
                  title={label}
                  className={`rounded p-0.5 transition-opacity ${
                    active ? "opacity-100 ring-2 ring-zinc-400 ring-offset-1" : "opacity-35 hover:opacity-60"
                  }`}
                >
                  <DocTypeIcon mimeType={mimeType} className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Has comments */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onHasCommentsFilterChange(!hasCommentsFilter)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              hasCommentsFilter
                ? "bg-zinc-800 text-white"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
            }`}
          >
            Has comments
          </button>
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Labels */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">Labels</span>
          <div className="flex flex-wrap items-center gap-1">
            {labels.length === 0 ? (
              <span className="text-xs text-zinc-300">None</span>
            ) : (
              labels.map((label) => {
                const active = selectedLabelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    onClick={() => onLabelToggle(label.id)}
                    className={`rounded-full px-2 py-0.5 text-xs font-medium transition-opacity ${
                      active ? "opacity-100 ring-2 ring-offset-1 ring-zinc-400" : "opacity-40 hover:opacity-70"
                    }`}
                    style={{ backgroundColor: label.color ?? "#e4e4e7" }}
                  >
                    {label.name}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Role */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">Role</span>
          <button
            onClick={() => {
              if (roleFilter === null) onRoleFilterChange("AUTHOR");
              else if (roleFilter === "AUTHOR") onRoleFilterChange("NOT_AUTHOR");
              else onRoleFilterChange(null);
            }}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              roleFilter === "AUTHOR"
                ? ROLE_COLORS.AUTHOR.activeFilter
                : roleFilter === "NOT_AUTHOR"
                ? `${ROLE_COLORS.AUTHOR.inactiveFilter} ring-2 ring-blue-300 ring-offset-1`
                : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200"
            }`}
          >
            {roleFilter === "NOT_AUTHOR" ? <s>Author</s> : "Author"}
          </button>
        </div>

        <div className="h-4 w-px bg-zinc-200" />

        {/* Status */}
        <div className="flex items-center gap-1">
          {([false, true] as const).map((archived) => (
            <button
              key={String(archived)}
              onClick={() => onShowArchivedChange(archived)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                showArchived === archived
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              {archived ? "All" : "Active"}
            </button>
          ))}
        </div>

      </div>
    </fieldset>
  );
}

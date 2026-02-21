"use client";

import type { Label } from "@prisma/client";
import { Checkbox } from "@/components/ui/checkbox";

interface FilterBarProps {
  labels: Label[];
  showArchived: boolean;
  selectedLabelIds: string[];
  roleFilter: "AUTHOR" | "REVIEWER" | null;
  onShowArchivedChange: (v: boolean) => void;
  onLabelToggle: (id: string) => void;
  onRoleFilterChange: (role: "AUTHOR" | "REVIEWER" | null) => void;
}

export function FilterBar({
  labels,
  showArchived,
  selectedLabelIds,
  roleFilter,
  onShowArchivedChange,
  onLabelToggle,
  onRoleFilterChange,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
        <Checkbox
          checked={showArchived}
          onCheckedChange={(v) => onShowArchivedChange(!!v)}
        />
        Show archived
      </label>

      <div className="flex items-center gap-1">
        {(["AUTHOR", "REVIEWER"] as const).map((role) => (
          <button
            key={role}
            onClick={() => onRoleFilterChange(roleFilter === role ? null : role)}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              roleFilter === role
                ? role === "AUTHOR"
                  ? "bg-blue-100 text-blue-700 ring-2 ring-offset-1 ring-blue-300"
                  : "bg-zinc-200 text-zinc-700 ring-2 ring-offset-1 ring-zinc-400"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
            }`}
          >
            {role.charAt(0) + role.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400 uppercase tracking-wide">
            Filter by label:
          </span>
          {labels.map((label) => {
            const active = selectedLabelIds.includes(label.id);
            const bg = label.color ?? "#e4e4e7";
            return (
              <button
                key={label.id}
                onClick={() => onLabelToggle(label.id)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity ${
                  active ? "opacity-100 ring-2 ring-offset-1 ring-zinc-400" : "opacity-50"
                }`}
                style={{ backgroundColor: bg }}
              >
                {label.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

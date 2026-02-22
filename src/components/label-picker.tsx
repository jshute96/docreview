"use client";

import type { Label } from "@prisma/client";

interface LabelPickerProps {
  allLabels: Label[];
  selectedLabelIds: string[];
  onToggle: (id: string) => void;
}

export function LabelPicker({
  allLabels,
  selectedLabelIds,
  onToggle,
}: LabelPickerProps) {
  if (allLabels.length === 0) return null;

  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-500 uppercase tracking-wide">
        Labels
      </label>
      <div className="flex flex-wrap gap-1.5">
        {allLabels.map((label) => {
          const active = selectedLabelIds.includes(label.id);
          return (
            <button
              key={label.id}
              onClick={() => onToggle(label.id)}
              className={`rounded-full px-2 py-0.5 text-xs font-medium transition-opacity ${
                active ? "opacity-100 ring-2 ring-offset-1 ring-zinc-400" : "opacity-40 hover:opacity-70"
              }`}
              style={{ backgroundColor: label.color ?? "#e4e4e7" }}
            >
              {label.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

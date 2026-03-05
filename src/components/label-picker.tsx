"use client";

import { contrastText } from "@/lib/utils";
import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { Button } from "@/components/ui/button";
import { useLabels } from "@/contexts/label-context";

interface LabelPickerProps {
  selectedLabelIds: string[];
  onToggle: (id: string) => void;
  prefix?: React.ReactNode;
}

export function LabelPicker({
  selectedLabelIds,
  onToggle,
  prefix,
}: LabelPickerProps) {
  const { allLabels } = useLabels();

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-900 uppercase tracking-wide">
          Labels
        </label>
        <ManageLabelsDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              title="Edit labels"
            >
              Edit
            </Button>
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {prefix}
        {allLabels.length === 0 && !prefix && (
          <p className="text-xs text-zinc-400 italic">No labels created yet.</p>
        )}
        {allLabels.map((label) => {
          const active = selectedLabelIds.includes(label.labelId);
          const bg = label.color ?? "#e4e4e7";
          return (
            <button
              key={label.labelId}
              onClick={() => onToggle(label.labelId)}
              className={`rounded-full px-2 py-0.5 text-xs font-medium transition-opacity ${
                active ? "opacity-100 ring-2 ring-offset-1 ring-zinc-400" : "opacity-40 hover:opacity-70"
              }`}
              style={{ backgroundColor: bg, color: contrastText(bg) }}
            >
              {label.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { ManageLabelsDialog } from "@/components/manage-labels-dialog";
import { Button } from "@/components/ui/button";
import { useLabels } from "@/contexts/label-context";
import { DEFAULT_LABEL_COLOR, labelToggleStyle } from "@/lib/tones";

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
          return (
            <button
              key={label.labelId}
              onClick={() => onToggle(label.labelId)}
              data-label-color={label.color ?? DEFAULT_LABEL_COLOR}
              className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${active ? "" : "hover:brightness-95"}`}
              style={labelToggleStyle(label.color, active)}
            >
              {label.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import type { Label } from "@prisma/client";
import { contrastText } from "@/lib/utils";
import { CountChip } from "@/components/count-chip";

interface LabelBadgeProps {
  label: Label;
  onRemove?: () => void;
  /** Shown as a count chip after the name, e.g. how many docs use the label. */
  count?: number;
}

export function LabelBadge({ label, onRemove, count }: LabelBadgeProps) {
  const bg = label.color ?? "#e4e4e7";

  return (
    <span
      className={`inline-flex items-center ${count !== undefined ? "gap-1.5" : "gap-1"} rounded-full px-2 py-0.5 text-xs font-medium`}
      style={{ backgroundColor: bg, color: contrastText(bg) }}
    >
      {count === undefined ? (
        label.name
      ) : (
        <>
          {/* Screen readers get "Label X, count Y" instead of the bare "X Y". */}
          <span className="sr-only">{`Label ${label.name}, count ${count}`}</span>
          <span aria-hidden>{label.name}</span>
          <span aria-hidden className="inline-flex"><CountChip count={count} /></span>
        </>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 opacity-60 hover:opacity-100"
          aria-label={`Remove label ${label.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

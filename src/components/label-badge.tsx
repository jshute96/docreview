"use client";

import type { Label } from "@prisma/client";
import { contrastText } from "@/lib/utils";

interface LabelBadgeProps {
  label: Label;
  onRemove?: () => void;
}

export function LabelBadge({ label, onRemove }: LabelBadgeProps) {
  const bg = label.color ?? "#e4e4e7";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: bg, color: contrastText(bg) }}
    >
      {label.name}
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

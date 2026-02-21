"use client";

import type { Label } from "@prisma/client";

interface LabelBadgeProps {
  label: Label;
  onRemove?: () => void;
}

export function LabelBadge({ label, onRemove }: LabelBadgeProps) {
  const bg = label.color ?? "#e4e4e7";
  // Determine text color based on background luminance
  const hex = bg.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const textColor = luminance > 0.5 ? "#18181b" : "#fafafa";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: bg, color: textColor }}
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

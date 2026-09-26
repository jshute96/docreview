"use client";

import { Star } from "lucide-react";
import type { TriState } from "@/lib/tri-state";
import { useTriStateCycle, DiagonalStrike } from "@/components/tri-state-button";

// ---------------------------------------------------------------------------
// StarButton — toggle star on/off for a single doc or comment
// ---------------------------------------------------------------------------

interface StarButtonProps {
  starred: boolean;
  onToggle: () => void;
  className?: string;
  title?: string;
}

export function StarButton({ starred, onToggle, className = "", title }: StarButtonProps) {
  return (
    <button
      onClick={onToggle}
      title={title ?? (starred ? "Starred" : "Not starred")}
      className={`inline-flex items-center justify-center transition-colors ${className}`}
    >
      <Star
        // Unstarred outline is translucent black rather than a fixed gray so it
        // stays visible on tinted row backgrounds (selected, unread, etc.).
        className={`h-4 w-4 ${starred ? "text-amber-400" : "text-black/30 hover:text-black/50"}`}
        fill={starred ? "currentColor" : "none"}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriStateStarButton — tri-state filter: off / include / exclude
// Styled as a pill like the other TriStateButton filters, with the star icon
// in place of a text label.
// ---------------------------------------------------------------------------

// The star icon itself is always amber-400 (white when included) to match the
// row StarButton; the text color here only styles the count chip, which needs
// more contrast than amber-400 gives.
const STAR_FILTER_COLORS: Record<TriState, string> = {
  off: "bg-amber-50 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-100",
  include: "bg-amber-400 text-amber-950 ring-1 ring-amber-500",
  exclude: "bg-amber-50 text-amber-700 ring-1 ring-amber-300",
};

interface TriStateStarButtonProps {
  value: TriState;
  onChange: (v: TriState) => void;
  title?: string;
  /** Rendered after the star, e.g. a count chip. */
  suffix?: React.ReactNode;
}

export function TriStateStarButton({ value, onChange, title = "Filter by starred", suffix }: TriStateStarButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  return (
    <button
      onClick={handleClick}
      title={title}
      aria-label="Filter by starred"
      className={`relative inline-flex h-5 items-center gap-1.5 overflow-hidden rounded px-2 text-xs font-medium transition-colors ${STAR_FILTER_COLORS[value]}`}
    >
      <Star
        className={`h-3.5 w-3.5 ${value === "include" ? "text-white" : "text-amber-400"}`}
        fill={value === "off" ? "none" : "currentColor"}
      />
      {suffix}
      {value === "exclude" && <DiagonalStrike bgColor="#fffbeb" />}
    </button>
  );
}

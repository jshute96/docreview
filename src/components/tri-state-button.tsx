"use client";

import { useCallback, useRef } from "react";
import type { TriState } from "@/lib/tri-state";
import { cycleTriState } from "@/lib/tri-state";
import { contrastText } from "@/lib/utils";

// ---------------------------------------------------------------------------
// useTriStateCycle — slow-click-to-reset behavior
// If >500ms has elapsed since the last click and the filter is active (include
// or exclude), reset straight to "off" instead of cycling to the next state.
// This prevents accidental cycling when the user just wants to turn it off.
// ---------------------------------------------------------------------------

const SLOW_CLICK_MS = 500;

export function useTriStateCycle(value: TriState, onChange: (v: TriState) => void) {
  const lastClickRef = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastClickRef.current;
    lastClickRef.current = now;
    if (value !== "off" && elapsed > SLOW_CLICK_MS) {
      onChange("off");
    } else {
      onChange(cycleTriState(value));
    }
  }, [value, onChange]);
}

// ---------------------------------------------------------------------------
// DiagonalStrike — diagonal line overlay (top-left → bottom-right)
// Uses a lower luminance threshold than contrastText (0.3 vs 0.5) because a
// thin 2px line needs more contrast to be visible than filled text does.
// ---------------------------------------------------------------------------

function slashColor(hex: string): string {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#18181b";
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.3 ? "#18181b" : "#fafafa";
}

export function DiagonalStrike({ bgColor }: { bgColor: string }) {
  const stroke = slashColor(bgColor);
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        background:
          `linear-gradient(to bottom right, transparent calc(50% - 1px), ${stroke} calc(50% - 1px), ${stroke} calc(50% + 1px), transparent calc(50% + 1px))`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// TriStateButton — fixed-color button for Comments, Active, Author
// ---------------------------------------------------------------------------

export interface TriStateColorConfig {
  off: string;
  include: string;
  exclude: string;
}

export const TRISTATE_COLORS = {
  author: {
    off: "bg-blue-50 text-blue-400 hover:bg-blue-100",
    include: "bg-blue-600 text-white",
    exclude: "bg-blue-50 text-blue-400",
  },
} as const;

interface TriStateButtonProps {
  label: string;
  value: TriState;
  onChange: (next: TriState) => void;
  colors: TriStateColorConfig;
  className?: string;
  title?: string;
}

export function TriStateButton({
  label,
  value,
  onChange,
  colors,
  className = "",
  title,
}: TriStateButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  return (
    <button
      onClick={handleClick}
      title={title}
      className={`relative overflow-hidden px-2 py-0.5 text-xs font-medium transition-colors ${colors[value]} ${className}`}
    >
      {label}
      {value === "exclude" && <DiagonalStrike bgColor="#eff6ff" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriStateIconButton — for doc type icons (opacity + ring pattern)
// ---------------------------------------------------------------------------

interface TriStateIconButtonProps {
  value: TriState;
  onChange: (next: TriState) => void;
  title: string;
  iconColor: string;
  children: React.ReactNode;
}

export function TriStateIconButton({
  value,
  onChange,
  title,
  iconColor,
  children,
}: TriStateIconButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  const stateClass =
    value === "include"
      ? "opacity-100 ring-2 ring-zinc-400 ring-offset-1"
      : value === "exclude"
        ? "opacity-100"
        : "opacity-35 hover:opacity-60";

  return (
    <button
      onClick={handleClick}
      title={title}
      aria-label={`Filter by ${title}`}
      className={`relative overflow-hidden rounded p-0.5 transition-opacity ${stateClass}`}
    >
      {children}
      {value === "exclude" && <DiagonalStrike bgColor={iconColor} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriStateLabelButton — for dynamic-color label badges
// ---------------------------------------------------------------------------

interface TriStateLabelButtonProps {
  label: string;
  color: string | null;
  value: TriState;
  onChange: (next: TriState) => void;
  title?: string;
}

export function TriStateLabelButton({
  label,
  color,
  value,
  onChange,
  title,
}: TriStateLabelButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  const bg = color ?? "#e4e4e7";
  const stateClass =
    value === "include"
      ? "opacity-100 ring-2 ring-zinc-400 ring-offset-1"
      : value === "exclude"
        ? "opacity-100"
        : "opacity-40 hover:opacity-70";

  return (
    <button
      onClick={handleClick}
      title={title}
      className={`relative overflow-hidden rounded-full px-2 py-0.5 text-xs font-medium transition-opacity ${stateClass}`}
      style={{ backgroundColor: bg, color: contrastText(bg) }}
    >
      {label}
      {value === "exclude" && <DiagonalStrike bgColor={bg} />}
    </button>
  );
}

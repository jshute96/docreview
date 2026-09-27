"use client";

import { useCallback, useRef } from "react";
import type { TriState } from "@/lib/tri-state";
import { cycleTriState } from "@/lib/tri-state";
import { DEFAULT_LABEL_COLOR, labelToggleStyle, toneTriStateColors } from "@/lib/tones";
import { tintColor } from "@/lib/utils";

// ---------------------------------------------------------------------------
// useTriStateCycle — slow-click-to-reset behavior
// If >1000ms has elapsed since the last click and the filter is active (include
// or exclude), reset straight to "off" instead of cycling to the next state.
// This prevents accidental cycling when the user just wants to turn it off.
// ---------------------------------------------------------------------------

const SLOW_CLICK_MS = 1000;

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
  author: toneTriStateColors("blue"),
} as const;

interface TriStateButtonProps {
  label: string;
  value: TriState;
  onChange: (next: TriState) => void;
  colors: TriStateColorConfig;
  className?: string;
  title?: string;
  /** Rendered after the label, e.g. a count chip. */
  suffix?: React.ReactNode;
}

export function TriStateButton({
  label,
  value,
  onChange,
  colors,
  className = "",
  title,
  suffix,
}: TriStateButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  return (
    <button
      onClick={handleClick}
      title={title}
      className={`relative overflow-hidden px-2 py-0.5 text-xs font-medium transition-colors ${suffix ? "inline-flex items-center gap-1.5" : ""} ${colors[value]} ${className}`}
    >
      {label}
      {suffix}
      {value === "exclude" && <DiagonalStrike bgColor="#eff6ff" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriStateIconButton — for doc type icons (the icon shows the state)
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
  // The icon itself shows the state (tinted when not selected; see filter-bar);
  // the button only adds the excluded strike. No selected ring, matching the
  // Author and star filters next to it.
  const selected = value === "include";

  return (
    <button
      onClick={handleClick}
      title={title}
      aria-label={`Filter by ${title}`}
      className={`relative overflow-hidden rounded p-0.5 transition ${selected ? "" : "hover:brightness-95"}`}
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
  // Only "include" shows the full color. "exclude" keeps the unselected look
  // under the strike, like every other tri-state filter button.
  const selected = value === "include";
  const bg = color ?? DEFAULT_LABEL_COLOR;

  return (
    <button
      onClick={handleClick}
      title={title}
      data-label-color={bg}
      className={`relative overflow-hidden rounded-full px-2 py-0.5 text-xs font-medium transition ${selected ? "" : "hover:brightness-95"}`}
      style={labelToggleStyle(color, selected)}
    >
      {label}
      {value === "exclude" && <DiagonalStrike bgColor={tintColor(bg, 0.65)} />}
    </button>
  );
}

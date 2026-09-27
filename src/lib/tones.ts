import type { CSSProperties } from "react";
import type { TriState } from "@/lib/tri-state";
import { contrastText, labelBorderColor, tintColor } from "@/lib/utils";

/**
 * Shared color tones for badges and toggle buttons, so a status badge, its
 * filter button, and its dialog toggle all look alike. Each tone has:
 * - `soft`: the badge look, also the unselected filter/toggle look
 * - `hover`: hover fill for an unselected button
 * - `solid`: the selected look (and the "strong" badge, e.g. Assigned)
 *
 * Class names are spelled out in full because Tailwind only generates classes it
 * finds literally in the source; building them from a color name would not work.
 */
const TONE_CLASSES = {
  blue: {
    soft: "bg-blue-100 text-blue-700 ring-blue-300",
    hover: "hover:bg-blue-200",
    solid: "bg-blue-600 text-white ring-blue-700",
  },
  violet: {
    soft: "bg-violet-100 text-violet-700 ring-violet-300",
    hover: "hover:bg-violet-200",
    solid: "bg-violet-600 text-white ring-violet-700",
  },
  amber: {
    soft: "bg-amber-100 text-amber-700 ring-amber-300",
    hover: "hover:bg-amber-200",
    solid: "bg-amber-600 text-white ring-amber-700",
  },
  orange: {
    soft: "bg-orange-100 text-orange-700 ring-orange-300",
    hover: "hover:bg-orange-200",
    solid: "bg-orange-600 text-white ring-orange-700",
  },
  red: {
    soft: "bg-red-100 text-red-700 ring-red-300",
    hover: "hover:bg-red-200",
    solid: "bg-red-600 text-white ring-red-700",
  },
  green: {
    // Tailwind's green-300 is much lighter than the other -300s, so the border
    // uses green-400 to match their weight.
    soft: "bg-green-100 text-green-700 ring-green-400",
    hover: "hover:bg-green-200",
    solid: "bg-green-600 text-white ring-green-700",
  },
  emerald: {
    soft: "bg-emerald-100 text-emerald-700 ring-emerald-300",
    hover: "hover:bg-emerald-200",
    solid: "bg-emerald-600 text-white ring-emerald-700",
  },
  gray: {
    soft: "bg-zinc-100 text-zinc-700 ring-zinc-300",
    hover: "hover:bg-zinc-200",
    solid: "bg-zinc-600 text-white ring-zinc-700",
  },
  /** A step darker than `gray`, for Resolved, so it stands apart from plain gray badges. */
  grayDark: {
    // Border one step darker than the other tones' -300, since against a
    // zinc-200 fill a zinc-300 border barely shows.
    soft: "bg-zinc-200 text-zinc-700 ring-zinc-400",
    hover: "hover:bg-zinc-300",
    solid: "bg-zinc-600 text-white ring-zinc-700",
  },
} as const;

export type Tone = keyof typeof TONE_CLASSES;

/** Badge classes (colors and border only; the Badge component adds shape and text size). */
export function toneBadgeClass(tone: Tone, strong = false): string {
  const t = TONE_CLASSES[tone];
  return `ring-1 ring-inset ${strong ? t.solid : t.soft}`;
}

/** Classes for a two-state toggle (e.g. Role/State in the Edit dialog). */
export function toneToggleClass(tone: Tone, selected: boolean): string {
  const t = TONE_CLASSES[tone];
  return selected ? `ring-1 ${t.solid}` : `ring-1 ${t.soft} ${t.hover}`;
}

/** Classes for each state of a tri-state filter button. Excluded keeps the
 *  unselected look (the button adds a strike over it). */
export function toneTriStateColors(tone: Tone): Record<TriState, string> {
  const t = TONE_CLASSES[tone];
  return {
    off: `ring-1 ${t.soft} ${t.hover}`,
    include: `ring-1 ${t.solid}`,
    exclude: `ring-1 ${t.soft}`,
  };
}

/** Gray ring marking a selected label toggle: the equivalent of
 *  Tailwind's `ring-2 ring-zinc-400 ring-offset-1`, as a box-shadow so it can be
 *  combined with other inline shadows (an inline box-shadow overrides ring classes). */
export const SELECTED_RING_SHADOW = "0 0 0 1px #ffffff, 0 0 0 3px #a1a1aa";

/** Color for a label with no color set. */
export const DEFAULT_LABEL_COLOR = "#e4e4e7";

/** Inline style for a toggleable label pill (filter bar, label pickers).
 *  Unselected: a light tint of the label color with dark text and a
 *  full-color border. Fading the whole pill instead made the text unreadable,
 *  especially white text on dark labels. Selected: the full color with a darker
 *  border, plus the shared gray selected ring. */
export function labelToggleStyle(color: string | null, selected: boolean): CSSProperties {
  const bg = color ?? DEFAULT_LABEL_COLOR;
  const border = `inset 0 0 0 1px ${selected ? labelBorderColor(bg) : bg}`;
  return {
    backgroundColor: selected ? bg : tintColor(bg, 0.65),
    color: selected ? contrastText(bg) : "#27272a",
    boxShadow: selected ? `${border}, ${SELECTED_RING_SHADOW}` : border,
  };
}

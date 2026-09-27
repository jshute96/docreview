import { toneBadgeClass, toneToggleClass, type Tone } from "@/lib/tones";

/** Badge and two-state toggle classes for a tone (see `@/lib/tones`). */
function toneSet(tone: Tone) {
  return {
    badge: toneBadgeClass(tone),
    activeFilter: toneToggleClass(tone, true),
    inactiveFilter: toneToggleClass(tone, false),
  };
}

export const ROLE_COLORS = {
  AUTHOR: toneSet("blue"),
  REVIEWER: toneSet("violet"),
} as const;

export const STATUS_COLORS = {
  INBOX: toneSet("emerald"),
  ARCHIVED: toneSet("gray"),
} as const;

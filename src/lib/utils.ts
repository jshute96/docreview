import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Returns black or white text color for readable contrast against a hex background. */
export function contrastText(hex: string): string {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#18181b";
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#18181b" : "#fafafa";
}

export function formatDate(d: Date | null, omitSeconds = false, omitTime = false): string {
  if (!d || isNaN(d.getTime())) return "—";

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(!omitTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    ...(!omitTime && !omitSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)!.value;

  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  if (omitTime) return dateStr;

  const base = `${dateStr} ${get("hour")}:${get("minute")}`;
  return !omitSeconds ? `${base}:${get("second")}` : base;
}

/**
 * Screen for free-form date strings arriving from outside (JSON payloads,
 * DOM-scraped text) before they are turned into a Date. True when the string
 * can't be parsed into a correct absolute date on its own, and so should be
 * displayed verbatim instead. Two cases:
 *   - It doesn't parse at all (garbage).
 *   - It has no year. Year-less Docs timestamps ("6:29 PM Feb 21") mean the
 *     current year, but V8 parses them as year 2001, so a string that reached
 *     here without going through parseExtensionTimestamp() would render as
 *     2001. Showing the scraped text is better than showing a wrong date.
 * Only FriendlyDate needs this: the formatting helpers below take real Dates.
 */
export function isUnparseableDateString(s: string): boolean {
  return isNaN(new Date(s).getTime()) || !hasYear(s);
}

/**
 * Heuristic "does this date string carry its own year": any 4-digit run. Not a
 * real year check, but enough for the inputs we see (ISO strings and timestamps
 * scraped from the Docs UI), and shared so the two callers can't drift.
 */
export function hasYear(s: string): boolean {
  return /\d{4}/.test(s);
}

/** Friendly relative date: HH:MM (today), Wed, HH:MM (<6d), YYYY-MM-DD (older). */
export function formatDateFriendly(d: Date | null, now?: number): { text: string; tooltip: string } {
  // An invalid Date would make Intl throw RangeError below, so screen it here.
  if (!d || isNaN(d.getTime())) return { text: "—", tooltip: "" };
  const tooltip = formatDate(d);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)!.value;

  const nowMs = now ?? Date.now();
  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const nowGet = (t: Intl.DateTimeFormatPartTypes) => nowParts.find(p => p.type === t)!.value;
  const isToday = get("year") === nowGet("year") && get("month") === nowGet("month") && get("day") === nowGet("day");

  const diffMs = nowMs - d.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  let text: string;
  if (isToday) {
    text = `${get("hour")}:${get("minute")}`;
  } else if (diffHours >= 0 && diffHours < 6 * 24) {
    text = `${get("weekday")}, ${get("hour")}:${get("minute")}`;
  } else {
    text = `${get("year")}-${get("month")}-${get("day")}`;
  }

  return { text, tooltip };
}

/** Append text to existing notes, adding a newline separator if needed. */
export function appendNotes(existing: string | null, addition: string): string {
  let notes = existing ?? "";
  if (notes.length > 0 && !notes.endsWith("\n")) {
    notes += "\n";
  }
  notes += addition;
  return notes;
}

/** Simple pluralization: pluralize(count, "apple") -> "1 apple", "2 apples", "0 apples". */
export function pluralize(count: number, singular: string, plural?: string): string {
  const p = plural ?? `${singular}s`;
  return `${count} ${count === 1 ? singular : p}`;
}

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

export function formatDate(d: Date | string | null, omitSeconds = false, omitTime = false): string {
  if (!d) return "—";
  const dt = new Date(d);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(!omitTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    ...(!omitTime && !omitSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(dt);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)!.value;

  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  if (omitTime) return dateStr;

  const base = `${dateStr} ${get("hour")}:${get("minute")}`;
  return !omitSeconds ? `${base}:${get("second")}` : base;
}

/** Friendly relative date: HH:MM (today), Wed, HH:MM (<6d), YYYY-MM-DD (older). */
export function formatDateFriendly(d: Date | string | null, now?: number): { text: string; tooltip: string } {
  if (!d) return { text: "—", tooltip: "" };
  const dt = new Date(d);
  const tooltip = formatDate(dt);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(dt);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)!.value;

  const nowMs = now ?? Date.now();
  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const nowGet = (t: Intl.DateTimeFormatPartTypes) => nowParts.find(p => p.type === t)!.value;
  const isToday = get("year") === nowGet("year") && get("month") === nowGet("month") && get("day") === nowGet("day");

  const diffMs = nowMs - dt.getTime();
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

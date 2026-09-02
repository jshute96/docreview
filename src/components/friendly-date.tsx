import { formatDateFriendly, isUnparseableDateString } from "@/lib/utils";

/**
 * Renders a timestamp using the app-wide friendly format (see formatDateFriendly).
 *
 * This is the one place free-form date strings are dealt with: `date` accepts a
 * `Date` (a Prisma/DB column) or a `string` (a timestamp that crossed a JSON
 * boundary, where `Date` doesn't survive — e.g. CommentThread.createdTime,
 * an ISO string on every path except an unresolvable scraped timestamp), and
 * the string is screened and converted here so the
 * formatting helpers in utils.ts only ever see real Dates. `null` (or "")
 * renders an em dash. `className` is optional; omitting it renders a span with
 * no class.
 */
export function FriendlyDate({ date, className }: { date: Date | string | null; className?: string }) {
  let parsed: Date | null = null;
  if (typeof date === "string") {
    // Backstop, expected never to fire: scraped Docs timestamps are resolved to
    // real dates by parseExtensionTimestamp() before they reach the UI. A string
    // that arrives here still unresolved is shown as-is rather than converted —
    // an unparseable one would make Intl throw, and a year-less one like
    // "6:29 PM Feb 21" would silently format as year 2001 (how V8 parses it).
    if (date && isUnparseableDateString(date)) {
      return <span className={className}>{date}</span>;
    }
    parsed = date ? new Date(date) : null; // "" means no date, same as null
  } else {
    parsed = date;
  }
  const { text, tooltip } = formatDateFriendly(parsed);
  return <span className={className} title={tooltip || undefined}>{text}</span>;
}

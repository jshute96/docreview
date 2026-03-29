import { formatDateFriendly } from "@/lib/utils";

export function FriendlyDate({ date, className }: { date: Date | string | null; className?: string }) {
  // If the date string isn't a valid parseable date (e.g., relative timestamps
  // like "6:29 PM Feb 21" from extension-scraped DOM data), display it as-is.
  if (typeof date === "string" && date && isNaN(new Date(date).getTime())) {
    return <span className={className}>{date}</span>;
  }
  const { text, tooltip } = formatDateFriendly(date);
  return <span className={className} title={tooltip || undefined}>{text}</span>;
}

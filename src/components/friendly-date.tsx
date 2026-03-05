import { formatDateFriendly } from "@/lib/utils";

export function FriendlyDate({ date, className }: { date: Date | string | null; className?: string }) {
  const { text, tooltip } = formatDateFriendly(date);
  return <span className={className} title={tooltip || undefined}>{text}</span>;
}

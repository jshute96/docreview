import { toneBadgeClass, type Tone } from "@/lib/tones";

interface BadgeProps {
  tone: Tone;
  /** Solid fill with white text, for badges that need to stand out (Assigned). */
  strong?: boolean;
  title?: string;
  children: React.ReactNode;
}

/** Small status badge (Author, Mine, Resolved, reply markers, ...). Shares its
 *  colors with the matching filter buttons via `@/lib/tones`. */
export function Badge({ tone, strong, title, children }: BadgeProps) {
  return (
    <span title={title} className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${toneBadgeClass(tone, strong)}`}>
      {children}
    </span>
  );
}

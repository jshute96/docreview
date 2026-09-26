/** Small rounded count shown after a button or badge label, tinted from the
 *  surrounding text color. `filled` is for solid (active) filter buttons, where
 *  the text is white and needs a stronger tint to show. Zero fades so the
 *  nonzero counts stand out. */
export function CountChip({ count, filled = false }: { count: number; filled?: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 text-[11px] leading-[14px] tabular-nums ${
        filled ? "bg-white/25" : "bg-current/15"
      } ${count === 0 ? "opacity-45" : ""}`}
    >
      {count}
    </span>
  );
}

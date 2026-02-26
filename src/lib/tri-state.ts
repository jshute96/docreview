export type TriState = "off" | "include" | "exclude";

/** Cycle: off → include → exclude → off */
export function cycleTriState(current: TriState): TriState {
  if (current === "off") return "include";
  if (current === "include") return "exclude";
  return "off";
}

/** Split a Record<string, TriState> into include/exclude arrays. */
export function partitionTriState(states: Record<string, TriState>): {
  include: string[];
  exclude: string[];
} {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const [key, value] of Object.entries(states)) {
    if (value === "include") include.push(key);
    else if (value === "exclude") exclude.push(key);
  }
  return { include, exclude };
}

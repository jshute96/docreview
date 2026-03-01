export type BulkEditState = "as-is" | "set" | "clear";

export function cycleBulkEditState(current: BulkEditState): BulkEditState {
  if (current === "as-is") return "set";
  if (current === "set") return "clear";
  return "as-is";
}

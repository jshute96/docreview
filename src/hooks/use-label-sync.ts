import { useEffect, Dispatch, SetStateAction } from "react";
import type { Label } from "@prisma/client";

/**
 * Keep selected label IDs in sync with the available labels list.
 * Removes any selected IDs that no longer exist in allLabels.
 */
export function useLabelSync(
  allLabels: Label[],
  setSelectedLabelIds: Dispatch<SetStateAction<string[]>>,
) {
  useEffect(() => {
    setSelectedLabelIds((prev) =>
      prev.filter((id) => allLabels.some((l) => l.id === id))
    );
  }, [allLabels, setSelectedLabelIds]);
}

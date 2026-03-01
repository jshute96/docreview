import { useCallback, useEffect, RefObject } from "react";

/**
 * Auto-resize a textarea to fit its content, capped at maxHeight.
 */
export function useAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = 200,
) {
  const resize = useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const capped = ta.scrollHeight > maxHeight;
    ta.style.height = (capped ? maxHeight : ta.scrollHeight) + "px";
    ta.style.overflowY = capped ? "auto" : "hidden";
  }, [ref, maxHeight]);

  useEffect(() => { resize(); }, [value, resize]);

  return resize;
}

import { useState, useRef, useCallback } from "react";

/**
 * Generic multi-selection hook for list rows.
 * Supports plain click, Ctrl/Cmd toggle, Shift range, and bulk removal.
 *
 * @param items - the current visible list (order matters for shift-click ranges)
 * @param getId - extract a unique string ID from each item
 */
export function useMultiSelect<T>(items: T[], getId: (item: T) => string) {
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const lastClickedIdRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setHighlightedIds(new Set());
    lastClickedIdRef.current = null;
  }, []);

  const effectiveItems = highlightedIds.size > 0
    ? items.filter(item => highlightedIds.has(getId(item)))
    : items;

  /**
   * Call from a row's onClick. Ignores clicks on nested buttons.
   */
  function handleRowClick(id: string, e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    if (e.shiftKey && lastClickedIdRef.current) {
      const anchorIdx = items.findIndex(item => getId(item) === lastClickedIdRef.current);
      const clickIdx = items.findIndex(item => getId(item) === id);
      if (anchorIdx === -1) {
        // Anchor item was removed — treat as plain click
        setHighlightedIds(new Set([id]));
        lastClickedIdRef.current = id;
        return;
      }
      const start = Math.min(anchorIdx, clickIdx);
      const end = Math.max(anchorIdx, clickIdx);
      const rangeIds = items.slice(start, end + 1).map(getId);
      if (e.ctrlKey || e.metaKey) {
        setHighlightedIds(prev => new Set([...prev, ...rangeIds]));
      } else {
        setHighlightedIds(new Set(rangeIds));
      }
    } else if (e.ctrlKey || e.metaKey) {
      setHighlightedIds(prev => {
        const updated = new Set(prev);
        if (updated.has(id)) updated.delete(id);
        else updated.add(id);
        return updated;
      });
      lastClickedIdRef.current = id;
    } else {
      if (highlightedIds.size === 1 && highlightedIds.has(id)) {
        setHighlightedIds(new Set());
        lastClickedIdRef.current = null;
      } else {
        setHighlightedIds(new Set([id]));
        lastClickedIdRef.current = id;
      }
    }
  }

  /** Remove a single ID from highlights (e.g. when its row is X-removed). */
  function removeFromHighlight(id: string) {
    setHighlightedIds(prev => {
      const updated = new Set(prev);
      updated.delete(id);
      return updated;
    });
    if (lastClickedIdRef.current === id) lastClickedIdRef.current = null;
  }

  /** Returns the set of highlighted IDs then clears all highlights. */
  function clearHighlights() {
    const ids = highlightedIds;
    setHighlightedIds(new Set());
    lastClickedIdRef.current = null;
    return ids;
  }

  /** Row className helper: highlighted bg vs hover bg. */
  function rowClassName(id: string, base: string = "") {
    const highlight = highlightedIds.has(id) ? "bg-blue-100" : "hover:bg-zinc-100";
    return `${base} cursor-default select-none ${highlight}`.trim();
  }

  return {
    highlightedIds,
    effectiveItems,
    handleRowClick,
    removeFromHighlight,
    clearHighlights,
    reset,
    rowClassName,
  };
}

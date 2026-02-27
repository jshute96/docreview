import React from "react";

/**
 * Highlight matching portions of text.  Tries the pattern as a regex first;
 * falls back to case-insensitive substring if the regex is invalid.
 * Returns the plain string when there is no pattern or no matches.
 */
export function highlightText(
  text: string,
  pattern: string,
): React.ReactNode {
  if (!pattern || !text) return text;

  let re: RegExp;
  try {
    re = new RegExp(`(${pattern})`, "gi");
  } catch {
    // Invalid regex — fall back to literal substring match (all occurrences)
    const lower = text.toLowerCase();
    const needle = pattern.toLowerCase();
    const parts: React.ReactNode[] = [];
    let start = 0;
    let idx: number;
    while ((idx = lower.indexOf(needle, start)) !== -1) {
      if (idx > start) parts.push(text.slice(start, idx));
      parts.push(<mark key={idx} className="bg-yellow-200">{text.slice(idx, idx + pattern.length)}</mark>);
      start = idx + pattern.length;
    }
    if (parts.length === 0) return text;
    if (start < text.length) parts.push(text.slice(start));
    return <>{parts}</>;
  }

  const parts = text.split(re);
  if (parts.length === 1) return text; // no match

  // split(/(group)/) puts captured matches at odd indices
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-yellow-200">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

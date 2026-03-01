import React from "react";

/**
 * Highlight literal substring matches.
 */
function highlightLiteral(text: string, pattern: string): React.ReactNode {
  const lower = text.toLowerCase();
  const needle = pattern.toLowerCase();
  const parts: React.ReactNode[] = [];
  let start = 0;
  let idx: number;
  while ((idx = lower.indexOf(needle, start)) !== -1) {
    if (idx > start) parts.push(text.slice(start, idx));
    parts.push(
      <mark key={idx} className="bg-yellow-200">
        {text.slice(idx, idx + pattern.length)}
      </mark>
    );
    start = idx + pattern.length;
  }
  if (parts.length === 0) return text;
  if (start < text.length) parts.push(text.slice(start));
  return <>{parts}</>;
}

/**
 * Highlight matching portions of text.
 * Tries regex first — if it produces non-empty matches, those are highlighted.
 * Otherwise tries literal substring match.
 */
export function highlightText(text: string, pattern: string): React.ReactNode {
  if (!pattern || !text) return text;

  // Try regex first
  try {
    const re = new RegExp(pattern, "gi");
    const parts: React.ReactNode[] = [];
    let start = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const matchIndex = match.index;
      const matchText = match[0];

      // Explicitly skip zero-length matches
      if (matchText.length === 0) {
        if (re.lastIndex === matchIndex) {
          re.lastIndex++;
        }
        continue;
      }

      if (matchIndex > start) {
        parts.push(text.slice(start, matchIndex));
      }

      parts.push(
        <mark key={matchIndex} className="bg-yellow-200">
          {matchText}
        </mark>
      );

      start = re.lastIndex;
    }

    if (parts.length > 0) {
      if (start < text.length) parts.push(text.slice(start));
      return <>{parts}</>;
    }
  } catch {
    // invalid regex — fall through to literal match
  }

  // Literal match — tried when regex was invalid or had no non-empty matches
  return highlightLiteral(text, pattern);
}

/**
 * Check if text matches a pattern. Tries both regex and literal substring —
 * returns true if either matches.
 */
export function matchesFilter(text: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!text) return false;

  // 1. Regex match first (consistent with highlightText)
  try {
    const re = new RegExp(pattern, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length > 0) return true;
      if (re.lastIndex === match.index) {
        re.lastIndex++;
      }
    }
  } catch {
    // invalid regex — skip to literal check
  }

  // 2. Literal substring
  if (text.toLowerCase().includes(pattern.toLowerCase())) return true;

  return false;
}

/**
 * Create a reusable matcher function that compiles the regex once.
 * Avoids recompiling on every call when filtering multiple items.
 */
export function createMatcher(pattern: string): (text: string) => boolean {
  if (!pattern) return () => true;

  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    // invalid regex — will use literal only
  }
  const needle = pattern.toLowerCase();

  return (text: string): boolean => {
    if (!text) return false;

    // Try regex
    if (re) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        if (match[0].length > 0) return true;
        if (re.lastIndex === match.index) {
          re.lastIndex++;
        }
      }
    }

    // Also try literal substring
    return text.toLowerCase().includes(needle);
  };
}

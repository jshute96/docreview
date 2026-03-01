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
 * Always checks both regex and literal substring match.
 * If both match, regex highlighting is preferred.
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

  // Fallback to literal match if regex was invalid or had no matches
  return highlightLiteral(text, pattern);
}

/**
 * Check if text matches a pattern using regex-first (consistent with highlightText),
 * falling back to literal substring match if regex is invalid.
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
    // invalid regex — fall through to literal match
  }

  // 2. Literal substring fallback
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

    // Regex first (consistent with highlightText)
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

    // Literal fallback
    return text.toLowerCase().includes(needle);
  };
}

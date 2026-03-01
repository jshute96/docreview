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
 * Check if text matches a pattern using either literal substring or regex.
 */
export function matchesFilter(text: string, pattern: string): boolean {
  if (!pattern) return true;
  if (!text) return false;

  // 1. Literal substring match
  if (text.toLowerCase().includes(pattern.toLowerCase())) return true;

  // 2. Regex match: find ANY non-empty match
  try {
    const re = new RegExp(pattern, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length > 0) return true;
      // Prevent infinite loop if regex engine doesn't advance
      if (re.lastIndex === match.index) {
        re.lastIndex++;
      }
    }
  } catch {
    // invalid regex
  }

  return false;
}

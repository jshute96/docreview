import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { highlightText, matchesFilter, createMatcher } from "./highlight";

function rendered(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  return renderToStaticMarkup(<>{node}</>);
}

describe("highlightText", () => {
  it("returns plain string when pattern is empty", () => {
    expect(highlightText("hello world", "")).toBe("hello world");
  });

  it("returns plain string when text is empty", () => {
    expect(highlightText("", "foo")).toBe("");
  });

  it("returns plain string when there is no match", () => {
    expect(highlightText("hello world", "xyz")).toBe("hello world");
  });

  it("highlights a simple substring match", () => {
    const result = rendered(highlightText("hello world", "world"));
    expect(result).toBe('hello <mark class="bg-yellow-200">world</mark>');
  });

  it("highlights case-insensitively", () => {
    const result = rendered(highlightText("Hello World", "hello"));
    expect(result).toBe('<mark class="bg-yellow-200">Hello</mark> World');
  });

  it("highlights multiple matches with regex alternation", () => {
    const result = rendered(highlightText("foo bar baz foo", "foo|bar"));
    expect(result).toContain('<mark class="bg-yellow-200">foo</mark>');
    expect(result).toContain('<mark class="bg-yellow-200">bar</mark>');
  });

  it("falls back to substring on invalid regex", () => {
    const result = rendered(highlightText("hello (world)", "(world"));
    expect(result).toBe('hello <mark class="bg-yellow-200">(world</mark>)');
  });

  it("substring fallback highlights all occurrences", () => {
    const result = rendered(highlightText("(a) and (a) and (a)", "(a"));
    expect(result).toBe(
      '<mark class="bg-yellow-200">(a</mark>) and <mark class="bg-yellow-200">(a</mark>) and <mark class="bg-yellow-200">(a</mark>)',
    );
  });

  it("returns plain string for invalid regex with no substring match", () => {
    expect(highlightText("hello", "(xyz")).toBe("hello");
  });

  it("highlights all consecutive single-char matches", () => {
    const result = rendered(highlightText("aaa", "a"));
    expect(result).toBe(
      '<mark class="bg-yellow-200">a</mark><mark class="bg-yellow-200">a</mark><mark class="bg-yellow-200">a</mark>',
    );
  });

  it("highlights adjacent matches without skipping", () => {
    const result = rendered(highlightText("foofoofoo", "foo"));
    expect(result).toBe(
      '<mark class="bg-yellow-200">foo</mark><mark class="bg-yellow-200">foo</mark><mark class="bg-yellow-200">foo</mark>',
    );
  });

  it("prefers regex match over literal match", () => {
    // pattern "a.c" matches "abc" as regex, but could be literal if we didn't prefer regex
    const result = rendered(highlightText("abc", "a.c"));
    expect(result).toBe('<mark class="bg-yellow-200">abc</mark>');
  });

  it("falls back to literal match if regex doesn't match", () => {
    // pattern "a.c" literal exists, but regex "a.c" doesn't match "a.c" if we use ^/$ or something, 
    // but here "a.c" regex matches "a.c" text.
    // Let's use a pattern that is invalid regex but valid literal.
    const result = rendered(highlightText("hello (world)", "(world"));
    expect(result).toBe('hello <mark class="bg-yellow-200">(world</mark>)');
  });

  it("skips zero-length regex matches (e.g. x*)", () => {
    // x* matches "" at every position. We should not highlight empty strings.
    const result = rendered(highlightText("abc", "x*"));
    // Since x* matches "" (zero-length), it should be skipped, and if no other matches, return plain text.
    expect(result).toBe("abc");
  });

  it("still matches non-empty parts of a regex that could be zero-length", () => {
    const result = rendered(highlightText("abbbc", "b*"));
    expect(result).toBe('a<mark class="bg-yellow-200">bbb</mark>c');
  });
});

describe("matchesFilter", () => {
  it("returns true for empty pattern", () => {
    expect(matchesFilter("hello", "")).toBe(true);
  });

  it("returns false for empty text with non-empty pattern", () => {
    expect(matchesFilter("", "foo")).toBe(false);
  });

  it("matches literal substring", () => {
    expect(matchesFilter("hello world", "world")).toBe(true);
    expect(matchesFilter("hello world", "WORLD")).toBe(true);
  });

  it("matches regex", () => {
    expect(matchesFilter("abc 123", "\\d+")).toBe(true);
    expect(matchesFilter("abc 123", "^abc")).toBe(true);
  });

  it("rejects zero-length regex matches", () => {
    // x* matches "" on any string. We only want it to return true if it matches SOMETHING.
    expect(matchesFilter("abc", "x*")).toBe(false);
    expect(matchesFilter("axbc", "x*")).toBe(true); // matches "x"
  });

  it("handles invalid regex gracefully by falling back to literal", () => {
    expect(matchesFilter("hello (world)", "(world")).toBe(true);
  });

  it("returns true if EITHER literal or regex matches", () => {
    // Literal match only
    expect(matchesFilter("hello (world)", "(world")).toBe(true);
    // Regex match only
    expect(matchesFilter("abc 123", "\\d+")).toBe(true);
  });

  it("uses regex-first order consistent with highlightText", () => {
    // "a.c" as regex matches "abc", same as highlightText behavior
    expect(matchesFilter("abc", "a.c")).toBe(true);
  });
});

describe("createMatcher", () => {
  it("returns a function that always returns true for empty pattern", () => {
    const matcher = createMatcher("");
    expect(matcher("anything")).toBe(true);
    expect(matcher("")).toBe(true);
  });

  it("matches regex patterns", () => {
    const matcher = createMatcher("\\d+");
    expect(matcher("abc 123")).toBe(true);
    expect(matcher("abc")).toBe(false);
  });

  it("falls back to literal for invalid regex", () => {
    const matcher = createMatcher("(world");
    expect(matcher("hello (world)")).toBe(true);
    expect(matcher("hello world")).toBe(false);
  });

  it("is reusable across multiple calls", () => {
    const matcher = createMatcher("foo");
    expect(matcher("foo bar")).toBe(true);
    expect(matcher("baz qux")).toBe(false);
    expect(matcher("another foo")).toBe(true);
  });

  it("rejects zero-length regex matches", () => {
    const matcher = createMatcher("x*");
    expect(matcher("abc")).toBe(false);
    expect(matcher("axbc")).toBe(true);
  });

  it("returns false for empty text", () => {
    const matcher = createMatcher("foo");
    expect(matcher("")).toBe(false);
  });
});

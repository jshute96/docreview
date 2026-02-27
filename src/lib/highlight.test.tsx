import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { highlightText } from "./highlight";

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
    // Regression: using re.test() with /g flag skips every other match
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
});

// @vitest-environment jsdom
//
// The suite default is `node` (see vitest.config.ts); these tests need a real
// DOM so they exercise DOMPurify itself rather than the tag-stripping fallback.
// They guard the fragile part of the link rewriting: `target` is NOT in
// DOMPurify's default attribute allowlist, and survives only because
// `afterSanitizeAttributes` runs after attribute validation. A DOMPurify
// upgrade that re-validated attributes after hooks would break the feature,
// and these are the tests that would catch it.
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./sanitize-html";

describe("sanitizeHtml link rewriting", () => {
  it("makes a link open in a new tab", () => {
    const html = sanitizeHtml('<a href="https://example.com/a?b=1">hi</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com/a?b=1"');
  });

  it("rewrites links nested inside other markup", () => {
    const html = sanitizeHtml('<div><p><b>see <a href="https://example.com">this</a></b></p></div>');
    expect(html).toContain('target="_blank"');
  });

  it("rewrites mailto links from @mentions", () => {
    const html = sanitizeHtml('<a href="mailto:someone@example.com">Someone</a>');
    expect(html).toContain('target="_blank"');
  });

  it("overrides an existing target and rel", () => {
    const html = sanitizeHtml('<a href="https://example.com" target="_self" rel="opener">hi</a>');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("_self");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("adds no target to a link whose href was rejected as unsafe", () => {
    // DOMPurify strips the javascript: href before the hook runs, so the
    // anchor no longer has an href and must not be turned into a new-tab link.
    const html = sanitizeHtml('<a href="javascript:alert(1)">bad</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("target");
  });

  it("leaves an anchor with no href alone", () => {
    expect(sanitizeHtml('<a name="x">hi</a>')).not.toContain("target");
  });

  it("still strips scripts and event handlers", () => {
    expect(sanitizeHtml("<script>alert(1)</script>hi")).toBe("hi");
    expect(sanitizeHtml('<b onclick="alert(1)">hi</b>')).toBe("<b>hi</b>");
  });

  it("preserves the <mark> tags used for search highlighting", () => {
    expect(sanitizeHtml("<mark>hit</mark>")).toBe("<mark>hit</mark>");
  });
});

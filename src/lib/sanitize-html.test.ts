import { describe, it, expect } from "vitest";
import { applyLinkTarget, sanitizeHtml } from "./sanitize-html";

/** Minimal stand-in for a DOM element (tests run in the `node` environment). */
function fakeNode(tagName: string, attrs: Record<string, string>) {
  return {
    tagName,
    attrs,
    hasAttribute: (n: string) => n in attrs,
    setAttribute: (n: string, v: string) => { attrs[n] = v; },
  };
}

describe("applyLinkTarget", () => {
  it("makes links open in a new tab", () => {
    const node = fakeNode("A", { href: "https://example.com" });
    applyLinkTarget(node as unknown as Element);
    expect(node.attrs.target).toBe("_blank");
    expect(node.attrs.rel).toBe("noopener noreferrer");
  });

  it("overrides an existing target", () => {
    const node = fakeNode("A", { href: "https://example.com", target: "_self" });
    applyLinkTarget(node as unknown as Element);
    expect(node.attrs.target).toBe("_blank");
  });

  it("leaves anchors without an href alone", () => {
    const node = fakeNode("A", {});
    applyLinkTarget(node as unknown as Element);
    expect(node.attrs.target).toBeUndefined();
  });

  it("leaves other elements alone", () => {
    const node = fakeNode("B", { href: "https://example.com" });
    applyLinkTarget(node as unknown as Element);
    expect(node.attrs.target).toBeUndefined();
  });

  it("matches lowercase SVG anchors too", () => {
    const node = fakeNode("a", { href: "https://example.com" });
    applyLinkTarget(node as unknown as Element);
    expect(node.attrs.target).toBe("_blank");
  });
});

describe("sanitizeHtml on the server", () => {
  // Tests run in the `node` environment, so there is no `window` and
  // sanitizeHtml takes its tag-stripping fallback path.
  it("strips all tags rather than rendering markup", () => {
    expect(sanitizeHtml('<a href="https://example.com">click</a>')).toBe("click");
    expect(sanitizeHtml("<b>hi</b> there")).toBe("hi there");
  });
});

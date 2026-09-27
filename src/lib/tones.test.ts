import { describe, it, expect } from "vitest";
import {
  DEFAULT_LABEL_COLOR,
  SELECTED_RING_SHADOW,
  labelToggleStyle,
  toneBadgeClass,
  toneToggleClass,
  toneTriStateColors,
} from "./tones";

describe("labelToggleStyle", () => {
  it("unselected: light tint, dark text, full-color border, no ring", () => {
    const s = labelToggleStyle("#000000", false);
    expect(s.backgroundColor).toBe("#a6a6a6");
    expect(s.color).toBe("#27272a");
    expect(s.boxShadow).toBe("inset 0 0 0 1px #000000");
  });

  it("selected: full color, contrasting text, darker border plus the gray ring", () => {
    const s = labelToggleStyle("#ffffff", true);
    expect(s.backgroundColor).toBe("#ffffff");
    expect(s.color).toBe("#18181b");
    expect(s.boxShadow).toBe(`inset 0 0 0 1px #cccccc, ${SELECTED_RING_SHADOW}`);
  });

  it("uses white text on a dark selected label", () => {
    expect(labelToggleStyle("#000000", true).color).toBe("#fafafa");
  });

  it("falls back to the default label color", () => {
    expect(labelToggleStyle(null, true).backgroundColor).toBe(DEFAULT_LABEL_COLOR);
  });
});

describe("tone classes", () => {
  it("badge is the soft look with an inset ring; strong is the solid look", () => {
    expect(toneBadgeClass("blue")).toBe("ring-1 ring-inset bg-blue-100 text-blue-700 ring-blue-300");
    expect(toneBadgeClass("amber", true)).toBe("ring-1 ring-inset bg-amber-600 text-white ring-amber-700");
  });

  it("tri-state: off and exclude share the soft look, include is solid", () => {
    const c = toneTriStateColors("violet");
    expect(c.off).toContain("bg-violet-100");
    expect(c.off).toContain("hover:bg-violet-200");
    expect(c.exclude).toBe("ring-1 bg-violet-100 text-violet-700 ring-violet-300");
    expect(c.include).toBe("ring-1 bg-violet-600 text-white ring-violet-700");
  });

  it("toggle matches the tri-state off/include looks", () => {
    const c = toneTriStateColors("emerald");
    expect(toneToggleClass("emerald", false)).toBe(c.off);
    expect(toneToggleClass("emerald", true)).toBe(c.include);
  });
});

import { describe, it, expect } from "vitest";
import { contrastText, formatDate } from "./utils";

describe("contrastText", () => {
  it("returns dark text for white background", () => {
    expect(contrastText("#ffffff")).toBe("#18181b");
  });

  it("returns light text for black background", () => {
    expect(contrastText("#000000")).toBe("#fafafa");
  });

  it("returns dark text for bright yellow", () => {
    expect(contrastText("#ffff00")).toBe("#18181b");
  });

  it("returns light text for dark blue", () => {
    expect(contrastText("#00008b")).toBe("#fafafa");
  });

  it("handles hex without leading #", () => {
    expect(contrastText("000000")).toBe("#fafafa");
  });

  it("returns default dark for invalid hex", () => {
    expect(contrastText("gggggg")).toBe("#18181b");
    expect(contrastText("#fff")).toBe("#18181b");
    expect(contrastText("")).toBe("#18181b");
  });

  it("returns dark text for mid-gray above threshold", () => {
    // rgb(145,145,145) → luminance = 145/255 ≈ 0.569 > 0.5
    expect(contrastText("#919191")).toBe("#18181b");
  });

  it("returns light text for mid-gray below threshold", () => {
    // rgb(127,127,127) → luminance = 127/255 ≈ 0.498 < 0.5
    expect(contrastText("#7f7f7f")).toBe("#fafafa");
  });
});

describe("formatDate", () => {
  it("returns em dash for null", () => {
    expect(formatDate(null)).toBe("—");
  });

  it("formats a Date object (with seconds by default)", () => {
    const d = new Date(2024, 0, 5, 9, 3, 45); // Jan 5, 2024 09:03:45 local
    expect(formatDate(d)).toBe("2024-01-05 09:03:45");
  });

  it("omits seconds when omitSeconds is true", () => {
    const d = new Date(2024, 2, 1, 8, 5, 9); // Mar 1, 2024 08:05:09
    expect(formatDate(d, true)).toBe("2024-03-01 08:05");
  });
});

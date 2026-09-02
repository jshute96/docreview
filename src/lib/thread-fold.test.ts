import { describe, it, expect } from "vitest";
import { estimateLines, foldEnd, MIN_LINES_TO_HIDE_ONE } from "./thread-fold";

// 700px / 7px per character = 100 columns.
const WIDTH = 700;
const short = "ok";
const long = "x".repeat(100 * MIN_LINES_TO_HIDE_ONE);

describe("estimateLines", () => {
  it("counts one line for text that fits", () => {
    expect(estimateLines(short, WIDTH)).toBe(1);
  });

  it("wraps at the available width", () => {
    expect(estimateLines("x".repeat(250), WIDTH)).toBe(3);
  });

  it("counts hard line breaks separately", () => {
    expect(estimateLines("a\nb\nc", WIDTH)).toBe(3);
    expect(estimateLines("a\n\nb", WIDTH)).toBe(3);
  });

  it("wraps more in a narrower panel", () => {
    expect(estimateLines("x".repeat(250), 350)).toBe(5);
  });

  it("returns 0 before the panel has been measured", () => {
    expect(estimateLines(long, 0)).toBe(0);
  });

  it("never divides by a nonsensical column count", () => {
    expect(estimateLines("x".repeat(40), 1)).toBe(2); // floored at 20 columns
  });
});

describe("foldEnd", () => {
  it("folds a run of two or more", () => {
    // 6 messages, 4 read: indices 1 and 2 fold, 0 and 3 stay.
    expect(foldEnd(4, 6, short, WIDTH)).toBe(2);
    expect(foldEnd(10, 12, short, WIDTH)).toBe(8);
  });

  it("folds a lone read message only when it is long", () => {
    expect(foldEnd(3, 5, short, WIDTH)).toBe(0);
    expect(foldEnd(3, 5, long, WIDTH)).toBe(1);
  });

  it("respects the line threshold exactly", () => {
    const justUnder = "x".repeat(100 * (MIN_LINES_TO_HIDE_ONE - 1));
    expect(estimateLines(justUnder, WIDTH)).toBe(MIN_LINES_TO_HIDE_ONE - 1);
    expect(foldEnd(3, 5, justUnder, WIDTH)).toBe(0);
  });

  it("folds nothing when the thread is fully read", () => {
    expect(foldEnd(6, 6, long, WIDTH)).toBe(0);
    // A stored count above the live total (a deleted reply) still counts as read.
    expect(foldEnd(9, 6, long, WIDTH)).toBe(0);
  });

  it("folds nothing when there is no room between the messages that stay", () => {
    expect(foldEnd(0, 4, long, WIDTH)).toBe(0);
    expect(foldEnd(1, 4, long, WIDTH)).toBe(0);
    expect(foldEnd(2, 4, long, WIDTH)).toBe(0);
  });

  it("folds nothing before the panel has been measured", () => {
    expect(foldEnd(3, 5, long, 0)).toBe(0);
  });
});

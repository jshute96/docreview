import { describe, it, expect } from "vitest";
import { appendNotes, contrastText, formatDate, formatDateFriendly } from "./utils";

describe("appendNotes", () => {
  it("returns addition when existing is null", () => {
    expect(appendNotes(null, "new note")).toBe("new note");
  });

  it("returns addition when existing is empty string", () => {
    expect(appendNotes("", "new note")).toBe("new note");
  });

  it("adds newline separator when existing has no trailing newline", () => {
    expect(appendNotes("existing", "new note")).toBe("existing\nnew note");
  });

  it("does not double newline when existing ends with newline", () => {
    expect(appendNotes("existing\n", "new note")).toBe("existing\nnew note");
  });

  it("handles multi-line existing notes", () => {
    expect(appendNotes("line1\nline2", "line3")).toBe("line1\nline2\nline3");
  });
});

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
    // 2024-01-05 09:03:45 PST = 2024-01-05T17:03:45Z
    const d = new Date("2024-01-05T17:03:45Z");
    expect(formatDate(d)).toBe("2024-01-05 09:03:45");
  });

  it("omits seconds when omitSeconds is true", () => {
    // 2024-03-01 08:05:09 PST = 2024-03-01T16:05:09Z
    const d = new Date("2024-03-01T16:05:09Z");
    expect(formatDate(d, true)).toBe("2024-03-01 08:05");
  });

  it("formats midnight correctly (hour 00, not 24)", () => {
    // 2024-01-01 00:00:00 PST = 2024-01-01T08:00:00Z
    const d = new Date("2024-01-01T08:00:00Z");
    expect(formatDate(d)).toBe("2024-01-01 00:00:00");
  });
});

describe("formatDateFriendly", () => {
  // Use a fixed "now" of 2024-06-15 12:00:00 PST = 2024-06-15T19:00:00Z
  const now = new Date("2024-06-15T19:00:00Z").getTime();

  it("returns em dash for null", () => {
    expect(formatDateFriendly(null).text).toBe("—");
    expect(formatDateFriendly(null).tooltip).toBe("");
  });

  it("shows HH:MM for timestamps today", () => {
    // Same day: 2024-06-15 10:00:00 PDT = 2024-06-15T17:00:00Z
    const d = new Date("2024-06-15T17:00:00Z");
    const { text, tooltip } = formatDateFriendly(d, now);
    expect(text).toBe("10:00");
    expect(tooltip).toBe("2024-06-15 10:00:00");
  });

  it("shows weekday HH:MM for yesterday (within 7 days)", () => {
    // Yesterday early: 2024-06-14 09:00:00 PDT (Fri) = 2024-06-14T16:00:00Z
    const d = new Date("2024-06-14T16:00:00Z");
    const { text, tooltip } = formatDateFriendly(d, now);
    expect(text).toBe("Fri, 09:00");
    expect(tooltip).toBe("2024-06-14 09:00:00");
  });

  it("shows weekday HH:MM for timestamps within 7 days", () => {
    // 3 days ago: 2024-06-12 12:00:00 PDT (Wed) = 2024-06-12T19:00:00Z
    const d = new Date("2024-06-12T19:00:00Z");
    const { text, tooltip } = formatDateFriendly(d, now);
    expect(text).toBe("Wed, 12:00");
    expect(tooltip).toBe("2024-06-12 12:00:00");
  });

  it("shows YYYY-MM-DD for timestamps older than 7 days", () => {
    // 30 days ago: 2024-05-16 12:00:00 PDT = 2024-05-16T19:00:00Z
    const d = new Date("2024-05-16T19:00:00Z");
    const { text, tooltip } = formatDateFriendly(d, now);
    expect(text).toBe("2024-05-16");
    expect(tooltip).toBe("2024-05-16 12:00:00");
  });

  it("shows YYYY-MM-DD for future timestamps", () => {
    // 2 days in future
    const d = new Date("2024-06-17T19:00:00Z");
    const { text } = formatDateFriendly(d, now);
    expect(text).toBe("2024-06-17");
  });

  it("earlier today still shows just HH:MM, not weekday", () => {
    // Early morning same day: 2024-06-15 00:30:00 PDT = 2024-06-15T07:30:00Z
    const d = new Date("2024-06-15T07:30:00Z");
    const { text } = formatDateFriendly(d, now);
    expect(text).toBe("00:30");
  });
});

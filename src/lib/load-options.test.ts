import { describe, it, expect } from "vitest";
import { parseLoadOptions } from "./load-options";

describe("parseLoadOptions", () => {
  it("returns defaults for empty body", () => {
    expect(parseLoadOptions({})).toEqual({
      daysBack: 30,
      ownership: "all",
      includeSharedDrives: false,
      source: "drive",
    });
  });

  it("accepts valid daysBack", () => {
    expect(parseLoadOptions({ daysBack: 7 }).daysBack).toBe(7);
    expect(parseLoadOptions({ daysBack: 365 }).daysBack).toBe(365);
    expect(parseLoadOptions({ daysBack: 1 }).daysBack).toBe(1);
  });

  it("clamps daysBack to minimum of 1", () => {
    expect(parseLoadOptions({ daysBack: 0 }).daysBack).toBe(1);
    expect(parseLoadOptions({ daysBack: -5 }).daysBack).toBe(1);
    expect(parseLoadOptions({ daysBack: 999 }).daysBack).toBe(999);
  });

  it("accepts null daysBack for all-time", () => {
    expect(parseLoadOptions({ daysBack: null }).daysBack).toBeNull();
  });

  it("defaults daysBack for non-number values", () => {
    expect(parseLoadOptions({ daysBack: "30" }).daysBack).toBe(30);
    expect(parseLoadOptions({ daysBack: true }).daysBack).toBe(30);
  });

  it("accepts valid ownership values", () => {
    expect(parseLoadOptions({ ownership: "all" }).ownership).toBe("all");
    expect(parseLoadOptions({ ownership: "owned" }).ownership).toBe("owned");
    expect(parseLoadOptions({ ownership: "shared-with-me" }).ownership).toBe("shared-with-me");
  });

  it("defaults ownership for invalid values", () => {
    expect(parseLoadOptions({ ownership: "bogus" }).ownership).toBe("all");
    expect(parseLoadOptions({ ownership: 42 }).ownership).toBe("all");
    expect(parseLoadOptions({ ownership: "" }).ownership).toBe("all");
  });

  it("parses includeSharedDrives as strict boolean", () => {
    expect(parseLoadOptions({ includeSharedDrives: true }).includeSharedDrives).toBe(true);
    expect(parseLoadOptions({ includeSharedDrives: false }).includeSharedDrives).toBe(false);
    expect(parseLoadOptions({ includeSharedDrives: "true" }).includeSharedDrives).toBe(false);
    expect(parseLoadOptions({ includeSharedDrives: 1 }).includeSharedDrives).toBe(false);
  });

  it("accepts valid source values", () => {
    expect(parseLoadOptions({ source: "drive" }).source).toBe("drive");
    expect(parseLoadOptions({ source: "gmail" }).source).toBe("gmail");
  });

  it("defaults source for invalid values", () => {
    expect(parseLoadOptions({ source: "bogus" }).source).toBe("drive");
    expect(parseLoadOptions({ source: 42 }).source).toBe("drive");
    expect(parseLoadOptions({}).source).toBe("drive");
  });
});

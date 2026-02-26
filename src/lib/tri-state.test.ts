import { describe, it, expect } from "vitest";
import { cycleTriState, partitionTriState } from "./tri-state";

describe("cycleTriState", () => {
  it("cycles off → include", () => {
    expect(cycleTriState("off")).toBe("include");
  });

  it("cycles include → exclude", () => {
    expect(cycleTriState("include")).toBe("exclude");
  });

  it("cycles exclude → off", () => {
    expect(cycleTriState("exclude")).toBe("off");
  });
});

describe("partitionTriState", () => {
  it("returns empty arrays for empty record", () => {
    expect(partitionTriState({})).toEqual({ include: [], exclude: [] });
  });

  it("returns empty arrays when all off", () => {
    expect(partitionTriState({ a: "off", b: "off" })).toEqual({
      include: [],
      exclude: [],
    });
  });

  it("partitions include and exclude entries", () => {
    const result = partitionTriState({
      a: "include",
      b: "exclude",
      c: "off",
      d: "include",
    });
    expect(result.include).toEqual(["a", "d"]);
    expect(result.exclude).toEqual(["b"]);
  });
});

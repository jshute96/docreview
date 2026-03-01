import { describe, it, expect } from "vitest";
import { cycleBulkEditState } from "./bulk-edit";

describe("cycleBulkEditState", () => {
  it("cycles as-is → set", () => {
    expect(cycleBulkEditState("as-is")).toBe("set");
  });

  it("cycles set → clear", () => {
    expect(cycleBulkEditState("set")).toBe("clear");
  });

  it("cycles clear → as-is", () => {
    expect(cycleBulkEditState("clear")).toBe("as-is");
  });
});

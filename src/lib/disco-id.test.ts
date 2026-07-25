import { describe, it, expect } from "vitest";
import { isDiscoId } from "./disco-id";

describe("isDiscoId", () => {
  it("accepts real-shaped disco IDs", () => {
    expect(isDiscoId("AAAB1agdt2A")).toBe(true);
    expect(isDiscoId("AAAB33Ml-HM")).toBe(true);
    expect(isDiscoId("AAAB0test123")).toBe(true);
    expect(isDiscoId("AAAB1c")).toBe(true);
  });

  it("rejects the placeholder the extension used to synthesize", () => {
    // Regression guard: this value used to reach Comment.googleCommentId, where
    // it could never match anything and blocked the row from ever being repaired.
    expect(isDiscoId("(no ID)")).toBe(false);
    expect(isDiscoId("(no IDs)")).toBe(false);
  });

  it("rejects empty and missing values", () => {
    expect(isDiscoId("")).toBe(false);
    expect(isDiscoId(null)).toBe(false);
    expect(isDiscoId(undefined)).toBe(false);
  });

  it("rejects malformed IDs", () => {
    expect(isDiscoId("AAAB")).toBe(false);       // nothing after the prefix letter
    expect(isDiscoId("AAA1abcd")).toBe(false);   // 4th char must be uppercase
    expect(isDiscoId("AABB1abcd")).toBe(false);  // wrong prefix
    expect(isDiscoId("aaab1abcd")).toBe(false);  // lowercase prefix
    expect(isDiscoId("AAAB1ab cd")).toBe(false); // whitespace
    expect(isDiscoId(" AAAB1abcd")).toBe(false); // leading whitespace
  });

  it("rejects non-string values", () => {
    expect(isDiscoId(123)).toBe(false);
    expect(isDiscoId({})).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";

// Mock heavy side-effect imports before importing the module under test
vi.mock("googleapis", () => ({ google: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { parseGoogleDocId } from "./google-drive";

describe("parseGoogleDocId", () => {
  it("extracts ID from a Google Docs URL", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit"
      )
    ).toBe("1aBcDeFgHiJkLmNoPqRsTuVwXyZ");
  });

  it("extracts ID from a Google Sheets URL", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/spreadsheets/d/abc-123_XYZ/edit#gid=0"
      )
    ).toBe("abc-123_XYZ");
  });

  it("extracts ID from a Google Slides URL", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/presentation/d/slideId123/edit"
      )
    ).toBe("slideId123");
  });

  it("returns null when /d/ segment is missing", () => {
    expect(
      parseGoogleDocId("https://docs.google.com/document/edit")
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGoogleDocId("")).toBeNull();
  });

  it("returns null for unrelated URL", () => {
    expect(parseGoogleDocId("https://example.com/page")).toBeNull();
  });

  it("extracts ID even with extra path segments after it", () => {
    expect(
      parseGoogleDocId(
        "https://docs.google.com/document/d/longId123/edit?usp=sharing"
      )
    ).toBe("longId123");
  });
});

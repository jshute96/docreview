import { describe, it, expect } from "vitest";
import { deletedContentWarning } from "./deleted-content-warning";

describe("deletedContentWarning", () => {
  it("returns undefined when thread is missing or not deleted", () => {
    expect(deletedContentWarning(undefined, false, false)).toBeUndefined();
    expect(deletedContentWarning({ originalContentDeleted: false }, false, false)).toBeUndefined();
    expect(deletedContentWarning({ originalContentDeleted: undefined }, false, false)).toBeUndefined();
  });

  it("names the thread type for open threads", () => {
    expect(deletedContentWarning({ originalContentDeleted: true }, false, false))
      .toBe("Original content deleted. This comment is not visible in the document.");
    expect(deletedContentWarning({ originalContentDeleted: true }, true, false))
      .toBe("Original content deleted. This suggestion is not visible in the document.");
  });

  it("says 'text' for a resolved comment with quoted text", () => {
    expect(deletedContentWarning(
      { originalContentDeleted: true, quotedFileContent: { value: "abc", mimeType: "text/plain" } }, false, true,
    )).toBe("Original content deleted. This text is not visible in the document.");
  });

  it("returns undefined for resolved suggestions", () => {
    expect(deletedContentWarning({ originalContentDeleted: true }, true, true)).toBeUndefined();
  });
});

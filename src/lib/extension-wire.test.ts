import { describe, it, expect } from "vitest";
import { CommentType } from "@prisma/client";
import { ExtCommentType, ExtSuggestionStatus, parseExtCommentType, parseCommentType, parseExtSuggestionStatus } from "./extension-wire";

// The extension sends the lowercase spelling in the sync request body and the
// uppercase (Prisma) spelling in the commentSynced tab message — each parser
// guards one boundary, and the broadcast one takes either spelling so an
// already-installed extension version keeps working.
describe("parseExtCommentType", () => {
  it("accepts the values the sync request body carries", () => {
    expect(parseExtCommentType("comment")).toBe(ExtCommentType.Comment);
    expect(parseExtCommentType("suggestion")).toBe(ExtCommentType.Suggestion);
  });

  it("rejects anything else, so an unusable hint falls back to a full sync", () => {
    expect(parseExtCommentType("SUGGESTION")).toBeUndefined();
    expect(parseExtCommentType("")).toBeUndefined();
    expect(parseExtCommentType(undefined)).toBeUndefined();
    expect(parseExtCommentType(3)).toBeUndefined();
  });
});

describe("parseExtSuggestionStatus", () => {
  it("keeps accepted and rejected", () => {
    expect(parseExtSuggestionStatus("accepted")).toBe(ExtSuggestionStatus.Accepted);
    expect(parseExtSuggestionStatus("rejected")).toBe(ExtSuggestionStatus.Rejected);
  });

  it("treats anything unrecognized as open, so it isn't recorded as resolved", () => {
    expect(parseExtSuggestionStatus("open")).toBe(ExtSuggestionStatus.Open);
    expect(parseExtSuggestionStatus(undefined)).toBe(ExtSuggestionStatus.Open);
    expect(parseExtSuggestionStatus("ACCEPTED")).toBe(ExtSuggestionStatus.Open);
  });
});

describe("parseCommentType", () => {
  it("accepts the values the commentSynced message carries", () => {
    expect(parseCommentType("SUGGESTION")).toBe(CommentType.SUGGESTION);
    expect(parseCommentType("COMMENT")).toBe(CommentType.COMMENT);
  });

  it("also accepts the lowercase spelling, in case an extension version sends it", () => {
    expect(parseCommentType("suggestion")).toBe(CommentType.SUGGESTION);
  });

  it("rejects anything it doesn't recognize", () => {
    expect(parseCommentType("thread")).toBeUndefined();
    expect(parseCommentType("")).toBeUndefined();
    expect(parseCommentType(undefined)).toBeUndefined();
  });
});

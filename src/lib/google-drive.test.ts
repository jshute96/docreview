import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  parseGoogleDocId,
  deriveCommentFlags,
  liveReplies,
  isDriveErrorCode,
  getDriveErrorCode,
  isInvalidGrantError,
} from "./google-drive";

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

  it("extracts ID from drive.google.com/open?id=ID URL", () => {
    expect(
      parseGoogleDocId(
        "https://drive.google.com/a/google.com/open?id=1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs"
      )
    ).toBe("1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs");
  });

  it("extracts ID from a direct doc ID (>= 20 chars)", () => {
    expect(parseGoogleDocId("1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs")).toBe(
      "1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs"
    );
  });

  it("unwraps Google redirect URL and extracts doc ID", () => {
    expect(
      parseGoogleDocId(
        "https://www.google.com/url?q=https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit&sa=D&source=docs&ust=1774893510554844&usg=AOvVaw0zrv3Q"
      )
    ).toBe("1aBcDeFgHiJkLmNoPqRsTuVwXyZ");
  });

  it("unwraps Google redirect URL pointing to a shortener (returns null)", () => {
    expect(
      parseGoogleDocId(
        "https://www.google.com/url?q=http://goto.google.com/basic-data-skills&sa=D&source=docs"
      )
    ).toBeNull();
  });

  it("unwraps Google redirect URL with drive.google.com/open?id=", () => {
    expect(
      parseGoogleDocId(
        "https://www.google.com/url?q=https://drive.google.com/open?id%3D1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs&sa=D"
      )
    ).toBe("1TGgHwuXMrUvTWsbvBUZn3jjOGUHJ7i0rrocWSdwyvgs");
  });
});

describe("deriveCommentFlags", () => {
  it("returns isThreadAuthor true when author.me is true", () => {
    const result = deriveCommentFlags({ me: true }, []);
    expect(result.isThreadAuthor).toBe(true);
  });

  it("returns isThreadAuthor false when author.me is false", () => {
    const result = deriveCommentFlags({ me: false }, []);
    expect(result.isThreadAuthor).toBe(false);
  });

  it("returns isThreadAuthor false when author is null", () => {
    const result = deriveCommentFlags(null, []);
    expect(result.isThreadAuthor).toBe(false);
  });

  it("returns isReplyAuthor true when a non-resolve reply is mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: null, author: { me: true } },
    ]);
    expect(result.isReplyAuthor).toBe(true);
  });

  it("returns isReplyAuthor true when only resolve reply is mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: "resolve", author: { me: true } },
    ]);
    expect(result.isReplyAuthor).toBe(true);
  });

  it("returns isReplyAuthor false when no replies are mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: null, author: { me: false } },
      { action: null, author: { me: false } },
    ]);
    expect(result.isReplyAuthor).toBe(false);
  });

  it("returns iResolvedIt true when last resolve reply is mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: "resolve", author: { me: false } },
      { action: null, author: { me: false } },
      { action: "resolve", author: { me: true } },
    ]);
    expect(result.iResolvedIt).toBe(true);
  });

  it("returns iResolvedIt false when last resolve reply is not mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: "resolve", author: { me: true } },
      { action: "resolve", author: { me: false } },
    ]);
    expect(result.iResolvedIt).toBe(false);
  });

  it("returns iResolvedIt false when there are no resolve replies", () => {
    const result = deriveCommentFlags({ me: true }, [
      { action: null, author: { me: true } },
    ]);
    expect(result.iResolvedIt).toBe(false);
  });

  it("returns isReplyAuthor false when thread author with only others' replies", () => {
    const result = deriveCommentFlags({ me: true }, [
      { action: null, author: { me: false } },
    ]);
    expect(result.isThreadAuthor).toBe(true);
    expect(result.isReplyAuthor).toBe(false);
  });

  it("handles empty replies array", () => {
    const result = deriveCommentFlags({ me: true }, []);
    expect(result).toEqual({ isThreadAuthor: true, isReplyAuthor: false, iResolvedIt: false, isRead: true });
  });
});

describe("isDriveErrorCode", () => {
  it("matches numeric err.code", () => {
    expect(isDriveErrorCode({ code: 404 }, 404)).toBe(true);
    expect(isDriveErrorCode({ code: 403 }, 403)).toBe(true);
  });

  it("matches stringified err.code", () => {
    expect(isDriveErrorCode({ code: "404" }, 404)).toBe(true);
    expect(isDriveErrorCode({ code: "403" }, 403)).toBe(true);
  });

  it("falls back to err.status when err.code is absent", () => {
    expect(isDriveErrorCode({ status: 403 }, 403)).toBe(true);
    expect(isDriveErrorCode({ status: "404" }, 404)).toBe(true);
  });

  it("returns false for non-matching codes", () => {
    expect(isDriveErrorCode({ code: 500 }, 404)).toBe(false);
    expect(isDriveErrorCode({ code: "500" }, 404)).toBe(false);
  });

  it("returns false for nullish/non-object errors", () => {
    expect(isDriveErrorCode(null, 404)).toBe(false);
    expect(isDriveErrorCode(undefined, 404)).toBe(false);
    expect(isDriveErrorCode("string error", 404)).toBe(false);
    expect(isDriveErrorCode(42, 404)).toBe(false);
  });

  it("returns false when neither code nor status are present", () => {
    expect(isDriveErrorCode({ message: "oops" }, 404)).toBe(false);
    expect(isDriveErrorCode({}, 404)).toBe(false);
  });

  it("handles real Error instances with a code property", () => {
    const err = Object.assign(new Error("boom"), { code: 404 });
    expect(isDriveErrorCode(err, 404)).toBe(true);
  });
});

describe("getDriveErrorCode", () => {
  it("returns numeric err.code as-is", () => {
    expect(getDriveErrorCode({ code: 404 })).toBe(404);
  });

  it("parses stringified err.code", () => {
    expect(getDriveErrorCode({ code: "500" })).toBe(500);
  });

  it("falls back to err.status when err.code missing", () => {
    expect(getDriveErrorCode({ status: 403 })).toBe(403);
    expect(getDriveErrorCode({ status: "429" })).toBe(429);
  });

  it("prefers err.code over err.status when both present", () => {
    expect(getDriveErrorCode({ code: 404, status: 200 })).toBe(404);
  });

  it("returns undefined for non-numeric / missing codes", () => {
    expect(getDriveErrorCode({})).toBeUndefined();
    expect(getDriveErrorCode({ code: "not-a-number" })).toBeUndefined();
    expect(getDriveErrorCode(null)).toBeUndefined();
    expect(getDriveErrorCode("oops")).toBeUndefined();
  });
});

describe("isInvalidGrantError", () => {
  it("matches Error instances whose message includes invalid_grant", () => {
    expect(isInvalidGrantError(new Error("400 invalid_grant"))).toBe(true);
  });

  it("matches plain errors with code=400 whose stringified form includes invalid_grant", () => {
    expect(isInvalidGrantError({ code: 400, toString: () => "invalid_grant" })).toBe(true);
  });

  it("does not match other 400 errors", () => {
    expect(isInvalidGrantError({ code: 400, message: "bad request" })).toBe(false);
  });

  it("does not match non-grant errors", () => {
    expect(isInvalidGrantError(new Error("some other error"))).toBe(false);
    expect(isInvalidGrantError({ code: 403 })).toBe(false);
    expect(isInvalidGrantError(null)).toBe(false);
  });
});

describe("liveReplies", () => {
  it("returns all replies when none are deleted", () => {
    const replies = [{ content: "a" }, { content: "b", deleted: false }];
    expect(liveReplies({ replies })).toHaveLength(2);
  });

  // comments.get returns deleted replies with deleted: true and their content
  // stripped; Google Docs hides them, so they must not render or be counted.
  it("drops replies marked deleted", () => {
    const replies = [
      { id: "r1", content: "kept" },
      { id: "r2", content: "", deleted: true },
      { id: "r3", content: "also kept" },
    ];
    expect(liveReplies({ replies }).map((r) => r.id)).toEqual(["r1", "r3"]);
  });

  it("returns an empty array when there are no replies", () => {
    expect(liveReplies({})).toEqual([]);
    expect(liveReplies({ replies: null })).toEqual([]);
  });
});

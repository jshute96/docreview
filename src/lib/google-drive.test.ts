import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { parseGoogleDocId, deriveCommentFlags } from "./google-drive";

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

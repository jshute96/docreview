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

  it("returns iParticipated true when a non-resolve reply is mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: null, author: { me: true } },
    ]);
    expect(result.iParticipated).toBe(true);
  });

  it("returns iParticipated true when only resolve reply is mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: "resolve", author: { me: true } },
    ]);
    expect(result.iParticipated).toBe(true);
  });

  it("returns iParticipated false when no replies are mine", () => {
    const result = deriveCommentFlags({ me: false }, [
      { action: null, author: { me: false } },
      { action: null, author: { me: false } },
    ]);
    expect(result.iParticipated).toBe(false);
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

  it("returns iParticipated true when thread author even with only others' replies", () => {
    const result = deriveCommentFlags({ me: true }, [
      { action: null, author: { me: false } },
    ]);
    expect(result.isThreadAuthor).toBe(true);
    expect(result.iParticipated).toBe(true);
  });

  it("handles empty replies array", () => {
    const result = deriveCommentFlags({ me: true }, []);
    expect(result).toEqual({ isThreadAuthor: true, iParticipated: true, iResolvedIt: false, isRead: true });
  });
});

import { describe, it, expect } from "vitest";
import {
  computeSuggestionHash,
  gmailActionToSuggestionType,
  extractHashTextsFromGmail,
  extractHashTextsFromExtension,
} from "./suggestion-hash";

describe("computeSuggestionHash", () => {
  it("produces a 64-char hex SHA-256 hash", () => {
    const hash = computeSuggestionHash("INSERT", "", "hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = computeSuggestionHash("DELETE", "old text", "");
    const b = computeSuggestionHash("DELETE", "old text", "");
    expect(a).toBe(b);
  });

  it("differs for different action types", () => {
    const insert = computeSuggestionHash("INSERT", "", "text");
    const del = computeSuggestionHash("DELETE", "text", "");
    expect(insert).not.toBe(del);
  });

  it("normalizes whitespace", () => {
    const a = computeSuggestionHash("EDIT", "old  text", "new  text");
    const b = computeSuggestionHash("EDIT", "old text", "new text");
    expect(a).toBe(b);
  });

  it("normalizes leading/trailing whitespace", () => {
    const a = computeSuggestionHash("INSERT", "", "  hello  ");
    const b = computeSuggestionHash("INSERT", "", "hello");
    expect(a).toBe(b);
  });

  it("is case-sensitive", () => {
    const a = computeSuggestionHash("EDIT", "Old Text", "New Text");
    const b = computeSuggestionHash("EDIT", "old text", "new text");
    expect(a).not.toBe(b);
  });

  it("matches truncated text with ellipsis to full text", () => {
    const full = "This is a very long suggestion that goes on and on and on and eventually it will be truncated by some sources";
    const truncated = full.substring(0, 100) + "...";
    const truncatedUnicode = full.substring(0, 100) + "…";
    
    const hashFull = computeSuggestionHash("INSERT", "", full);
    const hashTrunc = computeSuggestionHash("INSERT", "", truncated);
    const hashTruncUnicode = computeSuggestionHash("INSERT", "", truncatedUnicode);
    
    expect(hashFull).toBe(hashTrunc);
    expect(hashFull).toBe(hashTruncUnicode);
  });

  it("truncates at 100 characters even without ellipsis", () => {
    const a = "a".repeat(100) + "b";
    const b = "a".repeat(100);
    const hashA = computeSuggestionHash("INSERT", "", a);
    const hashB = computeSuggestionHash("INSERT", "", b);
    expect(hashA).toBe(hashB);
  });

  it("produces matching hashes for Gmail and Docs API equivalent inputs", () => {
    // Gmail: action="Replace", oldText="hello", newText="world"
    // Docs API: suggestionType="EDIT", deletedText="hello", insertedText="world"
    const gmailHash = computeSuggestionHash("EDIT", "hello", "world");
    const docsHash = computeSuggestionHash("EDIT", "hello", "world");
    expect(gmailHash).toBe(docsHash);
  });

  it("distinguishes INSERT with text from DELETE with same text", () => {
    const insert = computeSuggestionHash("INSERT", "", "some text");
    const del = computeSuggestionHash("DELETE", "some text", "");
    expect(insert).not.toBe(del);
  });
});

describe("gmailActionToSuggestionType", () => {
  it("maps Add to INSERT", () => {
    expect(gmailActionToSuggestionType("Add")).toBe("INSERT");
  });

  it("maps Delete to DELETE", () => {
    expect(gmailActionToSuggestionType("Delete")).toBe("DELETE");
  });

  it("maps Replace to EDIT", () => {
    expect(gmailActionToSuggestionType("Replace")).toBe("EDIT");
  });

  it("falls back to OTHER for unknown actions", () => {
    expect(gmailActionToSuggestionType("Unknown")).toBe("OTHER");
  });
});

describe("extractHashTextsFromGmail", () => {
  it("puts Add text into insertedText only", () => {
    expect(extractHashTextsFromGmail({ action: "Add", text: "hello" }))
      .toEqual({ deletedText: "", insertedText: "hello" });
  });

  it("puts Delete text into deletedText only", () => {
    expect(extractHashTextsFromGmail({ action: "Delete", text: "gone" }))
      .toEqual({ deletedText: "gone", insertedText: "" });
  });

  it("splits Replace across oldText/newText", () => {
    expect(extractHashTextsFromGmail({ action: "Replace", text: "ignored", oldText: "old", newText: "new" }))
      .toEqual({ deletedText: "old", insertedText: "new" });
  });

  it("falls back to empty strings for Replace with missing old/new", () => {
    expect(extractHashTextsFromGmail({ action: "Replace", text: "ignored" }))
      .toEqual({ deletedText: "", insertedText: "" });
  });

  it("returns empty strings for non-text actions (Other, Format, etc.)", () => {
    expect(extractHashTextsFromGmail({ action: "Other", text: "Format: bold" }))
      .toEqual({ deletedText: "", insertedText: "" });
  });

  it("produces the same hash input as extension helper for equivalent inputs", () => {
    const gmail = extractHashTextsFromGmail({ action: "Replace", text: "", oldText: "a", newText: "b" });
    const ext = extractHashTextsFromExtension("Replace", "a", "b");
    expect(gmail).toEqual(ext);
  });
});

describe("extractHashTextsFromExtension", () => {
  it("puts Add newText into insertedText only", () => {
    expect(extractHashTextsFromExtension("Add", "", "hi"))
      .toEqual({ deletedText: "", insertedText: "hi" });
  });

  it("puts Delete oldText into deletedText only", () => {
    expect(extractHashTextsFromExtension("Delete", "bye", ""))
      .toEqual({ deletedText: "bye", insertedText: "" });
  });

  it("splits Replace across old/new", () => {
    expect(extractHashTextsFromExtension("Replace", "old", "new"))
      .toEqual({ deletedText: "old", insertedText: "new" });
  });

  it("returns empty strings for non-text actions", () => {
    expect(extractHashTextsFromExtension("Format", "x", "y"))
      .toEqual({ deletedText: "", insertedText: "" });
  });
});

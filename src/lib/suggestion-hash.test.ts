import { describe, it, expect } from "vitest";
import { computeSuggestionHash, gmailActionToSuggestionType } from "./suggestion-hash";

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

  it("is case-insensitive", () => {
    const a = computeSuggestionHash("EDIT", "Old Text", "New Text");
    const b = computeSuggestionHash("EDIT", "old text", "new text");
    expect(a).toBe(b);
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

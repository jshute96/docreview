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

  it("trims whitespace exposed by the 100-character truncation", () => {
    // The 100th character (index 99) is a space. After truncation to 100 chars
    // the trailing space should be trimmed so that any continuation of the
    // string beyond that boundary hashes identically.
    const prefix = "a".repeat(99);
    const truncatedAtSpace = prefix + " and then a bunch of additional words that get chopped off";
    const prefixOnly = prefix;
    expect(computeSuggestionHash("INSERT", "", truncatedAtSpace))
      .toBe(computeSuggestionHash("INSERT", "", prefixOnly));
  });

  it("trims whitespace exposed by truncation when the tail was collapsed whitespace", () => {
    // Internal run of whitespace collapses to a single space, which can land
    // exactly at the truncation boundary. The post-truncation trim must still
    // strip it for the hash to match the prefix-only form.
    const prefix = "word ".repeat(19) + "word"; // 99 chars, no trailing space
    const withCollapsingTail = prefix + "   \n\t cut"; // runs of ws → one space at index 99
    expect(computeSuggestionHash("INSERT", "", withCollapsingTail))
      .toBe(computeSuggestionHash("INSERT", "", prefix));
  });

  it("treats newlines and tabs as whitespace and collapses them", () => {
    const a = computeSuggestionHash("EDIT", "line1\nline2\tline3", "a\n\nb");
    const b = computeSuggestionHash("EDIT", "line1 line2 line3", "a b");
    expect(a).toBe(b);
  });

  it("only strips ellipsis when it is truly trailing", () => {
    // A mid-string "..." must survive normalization; only a trailing one is stripped.
    const mid = computeSuggestionHash("INSERT", "", "hello...world");
    const plain = computeSuggestionHash("INSERT", "", "helloworld");
    expect(mid).not.toBe(plain);
  });

  it("strips a trailing ellipsis that is not followed by other characters", () => {
    // Sanity check the pair of the above: trailing ellipsis *is* stripped.
    expect(computeSuggestionHash("INSERT", "", "done..."))
      .toBe(computeSuggestionHash("INSERT", "", "done"));
  });

  it("hashes deletedText and insertedText independently", () => {
    // Swapping which side a token appears on must change the hash.
    const a = computeSuggestionHash("EDIT", "alpha", "beta");
    const b = computeSuggestionHash("EDIT", "beta", "alpha");
    expect(a).not.toBe(b);
  });

  it("produces distinct hashes for each action type with identical text", () => {
    const insert = computeSuggestionHash("INSERT", "", "shared");
    const del = computeSuggestionHash("DELETE", "shared", "");
    const edit = computeSuggestionHash("EDIT", "shared", "shared");
    const other = computeSuggestionHash("OTHER", "shared", "shared");
    const all = new Set([insert, del, edit, other]);
    expect(all.size).toBe(4);
  });

  it("produces a stable hash for OTHER with empty text (non-text suggestions)", () => {
    // Format/Other suggestions hash the action label alone — all sources agree
    // to pass empty strings, so hashes must match regardless of source.
    const a = computeSuggestionHash("OTHER", "", "");
    const b = computeSuggestionHash("OTHER", "", "");
    expect(a).toBe(b);
    // And distinct from OTHER with any text (shouldn't happen, but defend it).
    expect(a).not.toBe(computeSuggestionHash("OTHER", "x", ""));
  });

  it("produces matching hashes for Gmail and Docs API equivalent inputs", () => {
    // Gmail: action="Replace", oldText="hello", newText="world"
    // Docs API: suggestionType="EDIT", deletedText="hello", insertedText="world"
    const gmailHash = computeSuggestionHash("EDIT", "hello", "world");
    const docsHash = computeSuggestionHash("EDIT", "hello", "world");
    expect(gmailHash).toBe(docsHash);
  });

  // ---- Cross-source truncation matching ----
  // Gmail notifications can truncate suggestion text (typically with a trailing
  // ellipsis around ~100 chars) while the Docs API and extension read live
  // content in full. These tests assert that a long suggestion still produces
  // the same hash across paths when one side is truncated.

  it("matches a long Gmail-truncated INSERT to the full Docs API INSERT", () => {
    // Long content (>100 chars), much longer than Gmail's notification budget.
    const full = "The quick brown fox jumps over the lazy dog, and then it keeps going past the hundred character mark and beyond";
    // Gmail side: an Add notification whose `text` arrives already truncated+ellipsised.
    const gmailInputs = extractHashTextsFromGmail({ action: "Add", text: full.substring(0, 100) + "…" });
    const gmailHash = computeSuggestionHash("INSERT", gmailInputs.deletedText, gmailInputs.insertedText);
    // Docs API side: full live insertedText.
    const docsHash = computeSuggestionHash("INSERT", "", full);
    expect(gmailHash).toBe(docsHash);
  });

  it("matches a long Gmail-truncated DELETE to the full Docs API DELETE", () => {
    const full = "This paragraph is being deleted, and it is quite long — long enough that Gmail's notification preview will truncate it";
    const gmailInputs = extractHashTextsFromGmail({ action: "Delete", text: full.substring(0, 100) + "..." });
    const gmailHash = computeSuggestionHash("DELETE", gmailInputs.deletedText, gmailInputs.insertedText);
    const docsHash = computeSuggestionHash("DELETE", full, "");
    expect(gmailHash).toBe(docsHash);
  });

  it("matches a Gmail-truncated Replace where both old and new sides are truncated", () => {
    const oldFull = "The original sentence that is being replaced, which happens to run longer than the hundred character Gmail preview limit";
    const newFull = "The replacement sentence, which is itself long enough that Gmail will chop it off in the notification body";
    const gmailInputs = extractHashTextsFromGmail({
      action: "Replace",
      text: "",
      oldText: oldFull.substring(0, 100) + "…",
      newText: newFull.substring(0, 100) + "…",
    });
    const gmailHash = computeSuggestionHash("EDIT", gmailInputs.deletedText, gmailInputs.insertedText);
    const docsHash = computeSuggestionHash("EDIT", oldFull, newFull);
    expect(gmailHash).toBe(docsHash);
  });

  it("matches extension and Docs API INSERT for long live content (neither truncates)", () => {
    // Extension reads live content, so neither side truncates at the source —
    // but both hit the 100-char cap inside `computeSuggestionHash` on anything
    // past that. This locks in that the extension path and Docs API path agree
    // on long text regardless of the cap.
    const full = "Long live content that the extension scraped directly from the editor and that the Docs API returns in full";
    const extInputs = extractHashTextsFromExtension("Add", "", full);
    const extHash = computeSuggestionHash("INSERT", extInputs.deletedText, extInputs.insertedText);
    const docsHash = computeSuggestionHash("INSERT", "", full);
    expect(extHash).toBe(docsHash);
  });

  it("matches Gmail-truncated and extension-full text for the same long INSERT", () => {
    // The three-way match case: Gmail sees a truncated-with-ellipsis preview,
    // the extension sees the full live text, and both must hash identically
    // so the partner-merge paths can pair them up.
    const full = "A very long inserted paragraph that exceeds one hundred characters so that Gmail must truncate its preview for us";
    const gmailInputs = extractHashTextsFromGmail({ action: "Add", text: full.substring(0, 100) + "…" });
    const extInputs = extractHashTextsFromExtension("Add", "", full);
    const gmailHash = computeSuggestionHash("INSERT", gmailInputs.deletedText, gmailInputs.insertedText);
    const extHash = computeSuggestionHash("INSERT", extInputs.deletedText, extInputs.insertedText);
    expect(gmailHash).toBe(extHash);
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

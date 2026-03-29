import { describe, it, expect } from "vitest";
import { parseExtensionTimestamp, extensionToThread, extensionToSuggestionContent } from "./extension-suggestions";
import type { ExtensionSuggestion } from "./bridge-to-extension";

// ---------------------------------------------------------------------------
// parseExtensionTimestamp
// ---------------------------------------------------------------------------

describe("parseExtensionTimestamp", () => {
  it("returns null for empty string", () => {
    expect(parseExtensionTimestamp("")).toBeNull();
  });

  it("parses 'HH:MM AM/PM Mon DD' format", () => {
    const result = parseExtensionTimestamp("6:29 PM Feb 21");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getMonth()).toBe(1); // February
    expect(result!.getDate()).toBe(21);
    expect(result!.getHours()).toBe(18);
    expect(result!.getMinutes()).toBe(29);
  });

  it("parses morning time", () => {
    const result = parseExtensionTimestamp("5:06 AM Mar 21");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getHours()).toBe(5);
    expect(result!.getMinutes()).toBe(6);
    expect(result!.getMonth()).toBe(2); // March
  });

  it("rolls back to previous year if parsed date is in the future", () => {
    // Use a month that's definitely in the future
    const futureMonth = new Date();
    futureMonth.setMonth(futureMonth.getMonth() + 2);
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const ts = `1:00 PM ${monthNames[futureMonth.getMonth()]} 15`;
    const result = parseExtensionTimestamp(ts);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(new Date().getFullYear() - 1);
  });

  it("parses 'Yesterday' relative timestamp", () => {
    const result = parseExtensionTimestamp("5:06 AM Yesterday");
    expect(result).toBeInstanceOf(Date);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(result!.getDate()).toBe(yesterday.getDate());
    expect(result!.getHours()).toBe(5);
  });

  it("parses 'Today' relative timestamp", () => {
    const result = parseExtensionTimestamp("3:15 PM Today");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getDate()).toBe(new Date().getDate());
    expect(result!.getHours()).toBe(15);
  });

  it("is case-insensitive for Yesterday/Today", () => {
    expect(parseExtensionTimestamp("3:15 PM yesterday")).toBeInstanceOf(Date);
    expect(parseExtensionTimestamp("3:15 PM TODAY")).toBeInstanceOf(Date);
  });

  it("returns null for unparseable string", () => {
    expect(parseExtensionTimestamp("not a date")).toBeNull();
  });

  it("handles ISO date strings as fallback", () => {
    const result = parseExtensionTimestamp("2026-03-15T10:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getFullYear()).toBe(2026);
  });
});

const baseSuggestion: ExtensionSuggestion = {
  id: "AAAB0test123",
  suggestionType: "Replace",
  status: "open",
  oldText: "old",
  newText: "new",
  author: "Test User",
  isMine: false,
  timestamp: "6:29 PM Feb 21",
  replies: [],
};

// ---------------------------------------------------------------------------
// extensionToThread
// ---------------------------------------------------------------------------

describe("extensionToThread", () => {
  it("builds Replace content string", () => {
    const t = extensionToThread(baseSuggestion);
    expect(t.content).toBe('Replace "old" with "new"');
  });

  it("builds Add content string", () => {
    const t = extensionToThread({ ...baseSuggestion, suggestionType: "Add", newText: "inserted" });
    expect(t.content).toBe('Add "inserted"');
  });

  it("builds Delete content string", () => {
    const t = extensionToThread({ ...baseSuggestion, suggestionType: "Delete", oldText: "removed" });
    expect(t.content).toBe('Delete "removed"');
  });

  it("includes replies with action field", () => {
    const s = { ...baseSuggestion, replies: [
      { author: "A", isMine: false, timestamp: "1:00 PM Mar 1", text: "comment", html: "<b>comment</b>" },
      { author: "B", isMine: true, timestamp: "2:00 PM Mar 1", text: "", action: "accept" as const },
    ]};
    const t = extensionToThread(s);
    expect(t.replies).toHaveLength(2);
    expect(t.replies[0].content).toBe("comment");
    expect(t.replies[0].htmlContent).toBe("<b>comment</b>");
    expect(t.replies[0].action).toBeUndefined();
    expect(t.replies[1].action).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// extensionToSuggestionContent
// ---------------------------------------------------------------------------

describe("extensionToSuggestionContent", () => {
  it("extracts old/new text", () => {
    const sc = extensionToSuggestionContent(baseSuggestion);
    expect(sc.insertedText).toBe("new");
    expect(sc.deletedText).toBe("old");
  });
});

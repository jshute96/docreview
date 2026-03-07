import { describe, it, expect } from "vitest";
import { parseShareNote, extractShareMessage } from "./gmail-parse";

const SHARE_HEADERS = [
  { name: "From", value: '"Jeff Someone (via Google Docs)" <drive-shares-dm-noreply@google.com>' },
  { name: "Reply-To", value: "Jeff Someone <someone@somewhere.com>" },
  { name: "Date", value: "Tue, 03 Mar 2026 20:08:23 +0000" },
];

const SHARE_BODY_WITH_MESSAGE = [
  "I've shared an item with you:",
  "",
  "share test 2 - with a message",
  "https://docs.google.com/document/d/18QlPQjxUCMK3k3n1mNMe0n0kAt2VyE5bSi4xtzq_YxM/edit?usp=sharing&ts=69a73fb7",
  "",
  "It's not an attachment -- it's stored online. To open this item, just click  ",
  "the link above.",
  "",
  "Taste this doc!",
].join("\n");

const SHARE_BODY_NO_MESSAGE = [
  "I've shared an item with you:",
  "",
  "share test 2",
  "https://docs.google.com/document/d/18QlPQjxUCMK3k3n1mNMe0n0kAt2VyE5bSi4xtzq_YxM/edit?usp=sharing",
  "",
  "It's not an attachment -- it's stored online. To open this item, just click  ",
  "the link above.",
].join("\n");

describe("extractShareMessage", () => {
  it("extracts message after boilerplate", () => {
    expect(extractShareMessage(SHARE_BODY_WITH_MESSAGE)).toBe("Taste this doc!");
  });

  it("returns null when no message present", () => {
    expect(extractShareMessage(SHARE_BODY_NO_MESSAGE)).toBeNull();
  });

  it("returns null when no URL found", () => {
    expect(extractShareMessage("just some random text")).toBeNull();
  });

  it("handles multi-line share messages", () => {
    const body = SHARE_BODY_NO_MESSAGE + "\n\nLine 1\n\nLine 2";
    expect(extractShareMessage(body)).toBe("Line 1\n\nLine 2");
  });

  it("works with Sheets URLs", () => {
    const body = [
      "Intro text:",
      "",
      "My Sheet",
      "https://sheets.google.com/spreadsheets/d/abc123/edit",
      "",
      "Boilerplate paragraph.",
      "",
      "Check this out!",
    ].join("\n");
    expect(extractShareMessage(body)).toBe("Check this out!");
  });
});

describe("parseShareNote", () => {
  it("returns formatted note with name, email, date, and message", () => {
    const note = parseShareNote(SHARE_HEADERS, SHARE_BODY_WITH_MESSAGE);
    expect(note).toMatch(/^Shared by Jeff Someone \(someone@somewhere.com\) on 2026-03-03 12:08$/m);
    expect(note).toContain("\nTaste this doc!");
  });

  it("returns note without message when none present", () => {
    const note = parseShareNote(SHARE_HEADERS, SHARE_BODY_NO_MESSAGE);
    expect(note).toMatch(/^Shared by Jeff Someone \(someone@somewhere.com\) on 2026-03-03 12:08$/);
    expect(note).not.toContain("\n");
  });

  it("returns null for comment notification emails", () => {
    const commentHeaders = [
      { name: "From", value: '"Google Docs" <comments-noreply@docs.google.com>' },
      { name: "Date", value: "Tue, 03 Mar 2026 20:08:23 +0000" },
    ];
    expect(parseShareNote(commentHeaders, SHARE_BODY_WITH_MESSAGE)).toBeNull();
  });

  it("handles Reply-To with email only (no display name)", () => {
    const headers = [
      { name: "From", value: "<drive-shares-dm-noreply@google.com>" },
      { name: "Reply-To", value: "someone@example.com" },
      { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
    ];
    // No angle brackets in Reply-To, so regex won't match — falls back to "Shared"
    const note = parseShareNote(headers, SHARE_BODY_NO_MESSAGE);
    expect(note).toMatch(/^Shared on /);
  });

  it("handles missing Date header", () => {
    const headers = [
      { name: "From", value: "<drive-shares-dm-noreply@google.com>" },
      { name: "Reply-To", value: "Jeff Someone <someone@somewhere.com>" },
    ];
    const note = parseShareNote(headers, SHARE_BODY_NO_MESSAGE);
    expect(note).toBe("Shared by Jeff Someone (someone@somewhere.com)");
  });
});

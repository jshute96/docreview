import { describe, it, expect } from "vitest";
import { replyEditedTime, commentEditedTime } from "./comment-edits";

type Times = { createdTime?: string | null; modifiedTime?: string | null };

function reply(overrides: Times = {}): Times {
  return { createdTime: "2026-03-07T06:43:16.848Z", ...overrides };
}

/** commentEditedTime() over a comment created at 06:00, with the given replies. */
function edited(modifiedTime: string, replies: Times[] = []): string | null {
  return commentEditedTime("2026-03-07T06:00:00.000Z", modifiedTime, replies);
}

describe("replyEditedTime", () => {
  it("returns null when the reply carries no modifiedTime", () => {
    expect(replyEditedTime(reply())).toBeNull();
  });

  it("returns null when modifiedTime matches createdTime", () => {
    expect(replyEditedTime(reply({ modifiedTime: "2026-03-07T06:43:16.848Z" }))).toBeNull();
  });

  it("returns the edit time when modifiedTime is later", () => {
    expect(replyEditedTime(reply({ modifiedTime: "2026-09-02T12:01:58.284Z" })))
      .toBe("2026-09-02T12:01:58.284Z");
  });

  it("returns null when the timestamps aren't real dates", () => {
    expect(replyEditedTime(reply({ createdTime: "not a date", modifiedTime: "also not a date" })))
      .toBeNull();
  });

  it("returns null when createdTime is missing", () => {
    // parseCommentThread stores "" when Drive omits createdTime.
    expect(replyEditedTime({ createdTime: "", modifiedTime: "2026-09-02T12:01:58.284Z" }))
      .toBeNull();
  });
});

describe("commentEditedTime", () => {
  it("returns null when the comment was never modified", () => {
    expect(edited("2026-03-07T06:00:00.000Z")).toBeNull();
  });

  it("returns the edit time when the comment has no replies", () => {
    expect(edited("2026-03-07T06:30:00.000Z")).toBe("2026-03-07T06:30:00.000Z");
  });

  it("returns null when a reply explains the newer modifiedTime", () => {
    // Drive's comment modifiedTime is the max across the thread, so a reply
    // posted at the same instant accounts for it — no edit can be inferred.
    expect(edited("2026-03-07T06:43:16.848Z", [
      reply({ createdTime: "2026-03-07T06:43:16.848Z", modifiedTime: "2026-03-07T06:43:16.848Z" }),
    ])).toBeNull();
  });

  it("returns null when an edited reply explains the newer modifiedTime", () => {
    expect(edited("2026-09-02T12:01:58.284Z", [
      reply({ modifiedTime: "2026-09-02T12:01:58.284Z" }),
    ])).toBeNull();
  });

  it("returns null when a DELETED reply explains the newer modifiedTime", () => {
    // Deleting a reply stamps the deletion time on the reply AND on the
    // comment, so the deleted reply must still be passed in — filter it out
    // first and the deletion reads as an edit of the head comment.
    expect(edited("2026-04-01T13:30:08.422Z", [
      reply({ createdTime: "2026-04-01T13:29:59.225Z", modifiedTime: "2026-04-01T13:30:08.422Z" }),
    ])).toBeNull();
  });

  it("returns null when any reply carries no modifiedTime", () => {
    // Reply data without edit times can't rule out that a reply accounts for
    // the comment timestamp, so no edit is attributed to the head comment.
    expect(edited("2026-09-03T00:00:00.000Z", [reply()])).toBeNull();
  });

  it("checks every reply, not just the first", () => {
    expect(edited("2026-09-02T12:01:58.284Z", [
      reply({ modifiedTime: "2026-03-07T06:43:16.848Z" }),
      reply({ createdTime: "2026-09-02T12:01:58.284Z", modifiedTime: "2026-09-02T12:01:58.284Z" }),
      reply({ modifiedTime: "2026-03-07T07:00:00.000Z" }),
    ])).toBeNull();
  });

  it("returns the edit time when it is later than every reply", () => {
    expect(edited("2026-09-03T00:00:00.000Z", [
      reply({ modifiedTime: "2026-09-02T12:01:58.284Z" }),
      reply({ createdTime: "2026-09-01T00:00:00.000Z", modifiedTime: "2026-09-01T00:00:00.000Z" }),
    ])).toBe("2026-09-03T00:00:00.000Z");
  });

  it("returns null for scraped timestamps with no year", () => {
    // Extension-sourced threads carry Docs UI display strings, which parse to
    // the wrong year rather than failing outright; they never carry a
    // modifiedTime, so nothing is ever reported for them.
    expect(commentEditedTime("6:29 PM Feb 21", null, [])).toBeNull();
  });
});

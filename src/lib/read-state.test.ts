import { describe, it, expect } from "vitest";
import { isThreadRead, totalMessageCount, initialReadMessageCount, nextReadMessageCount } from "./read-state";

describe("totalMessageCount", () => {
  it("counts the head comment plus its replies", () => {
    expect(totalMessageCount(0)).toBe(1);
    expect(totalMessageCount(3)).toBe(4);
  });
});

describe("isThreadRead", () => {
  it("is read only when every message has been read", () => {
    expect(isThreadRead({ readMessageCount: 0, replyCount: 0 })).toBe(false);
    expect(isThreadRead({ readMessageCount: 1, replyCount: 0 })).toBe(true);
    expect(isThreadRead({ readMessageCount: 3, replyCount: 3 })).toBe(false); // 1 of 4 unread
    expect(isThreadRead({ readMessageCount: 4, replyCount: 3 })).toBe(true);
  });

  it("stays read when replies are deleted out from under the stored count", () => {
    // Thread was fully read at 5 replies; two were deleted since.
    expect(isThreadRead({ readMessageCount: 6, replyCount: 3 })).toBe(true);
  });
});

describe("initialReadMessageCount", () => {
  it("counts nothing read when I never posted in the thread", () => {
    expect(initialReadMessageCount(false, [])).toBe(0);
    expect(initialReadMessageCount(false, [false, false])).toBe(0);
  });

  it("counts the head comment when it's mine and there are no replies", () => {
    expect(initialReadMessageCount(true, [])).toBe(1);
  });

  it("counts everything when my reply is the last message", () => {
    // My comment + their reply + my reply = 3 messages, all read.
    expect(initialReadMessageCount(true, [false, true])).toBe(3);
  });

  it("seeds partial read state through my last reply", () => {
    // Their comment, my reply, then two replies I haven't seen: 2 of 4 read.
    expect(initialReadMessageCount(false, [true, false, false])).toBe(2);
  });

  it("uses my last contribution, not my first", () => {
    // Their comment, my reply, their reply, my reply, their reply: 4 of 6 read.
    expect(initialReadMessageCount(false, [true, false, true, false])).toBe(4);
  });
});

describe("nextReadMessageCount", () => {
  /** A thread read to the end at 2 replies, i.e. 3 of 3 messages. */
  const readAtTwo = { storedCount: 3, oldReplyCount: 2 };

  it("preserves the count when there's no activity", () => {
    expect(nextReadMessageCount({
      ...readAtTwo, newReplyCount: 2, hasActivity: false, iActedLast: false,
    })).toBe(3);
  });

  it("marks everything read when I posted the latest message", () => {
    expect(nextReadMessageCount({
      ...readAtTwo, newReplyCount: 4, hasActivity: true, iActedLast: true,
    })).toBe(5);
  });

  it("leaves the count alone when someone else replies", () => {
    // 3 of 5 — exactly the two new replies are unread.
    expect(nextReadMessageCount({
      ...readAtTwo, newReplyCount: 4, hasActivity: true, iActedLast: false,
    })).toBe(3);
  });

  it("keeps a manual mark-unread through someone else's replies", () => {
    expect(nextReadMessageCount({
      storedCount: 0, oldReplyCount: 2, newReplyCount: 4, hasActivity: true, iActedLast: false,
    })).toBe(0);
  });

  it("marks the last message unread on activity without new replies", () => {
    expect(nextReadMessageCount({
      ...readAtTwo, newReplyCount: 2, hasActivity: true, iActedLast: false,
    })).toBe(2);
  });

  it("clamps a stored count above the current total", () => {
    // Two replies deleted; clamped to 3, then the no-new-replies rule applies.
    expect(nextReadMessageCount({
      storedCount: 5, oldReplyCount: 4, newReplyCount: 2, hasActivity: true, iActedLast: false,
    })).toBe(2);
  });

  it("clamps without marking unread when there's no activity", () => {
    expect(nextReadMessageCount({
      storedCount: 5, oldReplyCount: 4, newReplyCount: 2, hasActivity: false, iActedLast: false,
    })).toBe(3);
  });

  it("never goes negative on an empty thread", () => {
    expect(nextReadMessageCount({
      storedCount: 0, oldReplyCount: 0, newReplyCount: 0, hasActivity: true, iActedLast: false,
    })).toBe(0);
  });
});

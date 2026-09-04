import { describe, it, expect } from "vitest";
import {
  initialReadSlotCount,
  isThreadRead,
  liveThreadReplies,
  nextReadSlotCount,
  noTombstones,
  renderReadCount,
  replyDeletedFlags,
  slotBoundaryFor,
  totalMessageCount,
  totalSlotCount,
  unreadMessageCount,
} from "./read-state";

/** Reply slots: `.` is live, `x` is a tombstone. Reads like the thread looks. */
const slots = (pattern: string) => [...pattern].map((ch) => ch === "x");

describe("totalMessageCount / totalSlotCount", () => {
  it("count the head comment plus the replies", () => {
    expect(totalMessageCount(0)).toBe(1);
    expect(totalMessageCount(3)).toBe(4);
    expect(totalSlotCount(3)).toBe(4);
  });
});

describe("renderReadCount", () => {
  it("is the identity when nothing is deleted", () => {
    expect(renderReadCount(slots("...."), 0)).toBe(0);
    expect(renderReadCount(slots("...."), 3)).toBe(3);
    expect(renderReadCount(slots("...."), 5)).toBe(5);
  });

  it("skips tombstones below the boundary", () => {
    // head + r0 + [deleted] + r2 read = 4 slots, but only 3 messages drawn.
    expect(renderReadCount(slots(".x.."), 4)).toBe(3);
  });

  it("ignores tombstones above the boundary", () => {
    expect(renderReadCount(slots(".x.."), 2)).toBe(2);
  });

  it("never counts past the messages that exist", () => {
    expect(renderReadCount(slots("xx"), 3)).toBe(1); // only the head is live
  });
});

describe("slotBoundaryFor", () => {
  it("round-trips with renderReadCount", () => {
    for (const pattern of ["....", ".x..", "xx..", "..xx", "x.x.x"]) {
      const flags = slots(pattern);
      const liveTotal = totalMessageCount(flags.filter((d) => !d).length);
      for (let n = 0; n <= liveTotal; n++) {
        expect(renderReadCount(flags, slotBoundaryFor(flags, n))).toBe(n);
      }
    }
  });

  it("puts the boundary after the tombstone when reading past it", () => {
    // Reading head + r0 + r2 means slots 0..3 are behind the boundary.
    expect(slotBoundaryFor(slots(".x.."), 3)).toBe(4);
  });

  it("swallows trailing tombstones when everything live is read", () => {
    expect(slotBoundaryFor(slots("..xx"), 3)).toBe(5);
  });

  it("handles the two ends", () => {
    expect(slotBoundaryFor(slots(".x."), 0)).toBe(0);
    expect(slotBoundaryFor(slots(".x."), 1)).toBe(1);
  });
});

describe("unreadMessageCount", () => {
  /** Unread is derived from the cached render-space read count and the live
   *  reply count, so replies arriving raise it with no write anywhere. */
  it("counts the head comment, so an unread thread with no replies has 1", () => {
    expect(unreadMessageCount({ readMessageCount: 0, replyCount: 0 })).toBe(1);
  });

  it("is 0 when fully read", () => {
    expect(unreadMessageCount({ readMessageCount: 3, replyCount: 2 })).toBe(0);
  });

  it("reports the messages past the read position", () => {
    expect(unreadMessageCount({ readMessageCount: 3, replyCount: 4 })).toBe(2);
  });

  it("clamps at 0 when a stored count exceeds the current total", () => {
    expect(unreadMessageCount({ readMessageCount: 6, replyCount: 3 })).toBe(0);
  });

  /** The bug slot space exists to fix. Deleting a read reply drops the cached
   *  read count and the live reply count together, so unread doesn't move. */
  it("keeps the unread count stable when a read reply is deleted", () => {
    const flags = slots(".....");
    const boundary = 3; // head + r0 + r1 read, of 6 messages
    expect(unreadMessageCount({
      readMessageCount: renderReadCount(flags, boundary), replyCount: 5,
    })).toBe(3);
    // r0 is deleted: the boundary holds, and the render count drops with the total.
    const after = slots("x....");
    expect(unreadMessageCount({
      readMessageCount: renderReadCount(after, boundary), replyCount: 4,
    })).toBe(3);
  });
});

describe("isThreadRead", () => {
  it("is read only when every live message has been read", () => {
    expect(isThreadRead({ readMessageCount: 0, replyCount: 0 })).toBe(false);
    expect(isThreadRead({ readMessageCount: 1, replyCount: 0 })).toBe(true);
    expect(isThreadRead({ readMessageCount: 3, replyCount: 3 })).toBe(false);
    expect(isThreadRead({ readMessageCount: 4, replyCount: 3 })).toBe(true);
  });

  it("stays read when replies are deleted out from under the stored count", () => {
    expect(isThreadRead({ readMessageCount: 6, replyCount: 3 })).toBe(true);
  });
});

describe("liveThreadReplies / replyDeletedFlags", () => {
  const replies = [{ id: "a" }, { id: "b", deleted: true }, { id: "c" }];

  it("drops tombstones for rendering but keeps their positions in the flags", () => {
    expect(liveThreadReplies(replies).map((r) => r.id)).toEqual(["a", "c"]);
    expect(replyDeletedFlags(replies)).toEqual([false, true, false]);
  });

  it("treats a source with no deleted field as all-live", () => {
    // A suggestion thread from the extension: no `deleted` anywhere.
    const noFlags: { id: string; deleted?: boolean }[] = [{ id: "a" }, { id: "b" }];
    expect(replyDeletedFlags(noFlags)).toEqual([false, false]);
  });
});

describe("noTombstones", () => {
  it("makes slot space the identity for a tombstone-free source", () => {
    expect(noTombstones(3)).toEqual([false, false, false]);
    expect(renderReadCount(noTombstones(3), 2)).toBe(2);
    expect(slotBoundaryFor(noTombstones(3), 2)).toBe(2);
  });
});

describe("initialReadSlotCount", () => {
  it("counts nothing read when I never posted in the thread", () => {
    expect(initialReadSlotCount(false, [])).toBe(0);
    expect(initialReadSlotCount(false, [false, false])).toBe(0);
  });

  it("counts the head comment when it's mine and there are no replies", () => {
    expect(initialReadSlotCount(true, [])).toBe(1);
  });

  it("counts everything when my reply is the last message", () => {
    // My comment + their reply + my reply = 3 messages, all read.
    expect(initialReadSlotCount(true, [false, true])).toBe(3);
  });

  it("seeds partial read state through my last reply", () => {
    // Their comment, my reply, then two replies I haven't seen: 2 of 4 read.
    expect(initialReadSlotCount(false, [true, false, false])).toBe(2);
  });

  it("uses my last contribution, not my first", () => {
    // Their comment, my reply, their reply, my reply, their reply: 4 of 6 read.
    expect(initialReadSlotCount(false, [true, false, true, false])).toBe(4);
  });

  it("counts a tombstone slot as not mine", () => {
    // A tombstone has no author in Drive's response, so it can never be my
    // last contribution — the boundary lands on the real reply before it.
    expect(initialReadSlotCount(false, [true, false])).toBe(2);
  });
});

describe("nextReadSlotCount", () => {
  /** A thread read to the end at 2 replies, i.e. 3 of 3 slots. */
  const readAtTwo = { storedCount: 3, oldReplySlotCount: 2 };

  it("preserves the boundary when there's no activity", () => {
    expect(nextReadSlotCount({
      ...readAtTwo, replyDeleted: noTombstones(2), hasActivity: false, iActedLast: false,
    })).toBe(3);
  });

  it("marks everything read when I posted the latest message", () => {
    expect(nextReadSlotCount({
      ...readAtTwo, replyDeleted: noTombstones(4), hasActivity: true, iActedLast: true,
    })).toBe(5);
  });

  it("leaves the boundary alone when someone else replies", () => {
    // 3 of 5 — exactly the two new replies are unread.
    expect(nextReadSlotCount({
      ...readAtTwo, replyDeleted: noTombstones(4), hasActivity: true, iActedLast: false,
    })).toBe(3);
  });

  it("keeps a manual mark-unread through someone else's replies", () => {
    expect(nextReadSlotCount({
      storedCount: 0, oldReplySlotCount: 2, replyDeleted: noTombstones(4),
      hasActivity: true, iActedLast: false,
    })).toBe(0);
  });

  it("marks the last message unread on activity without new slots", () => {
    expect(nextReadSlotCount({
      ...readAtTwo, replyDeleted: noTombstones(2), hasActivity: true, iActedLast: false,
    })).toBe(2);
  });

  it("marks the last *live* message unread when the thread ends in a tombstone", () => {
    // head + r0 + [deleted r1], read to the end. Resurfacing the thread has to
    // reach past the tombstone to r0, which is the last thing actually drawn.
    const result = nextReadSlotCount({
      storedCount: 3, oldReplySlotCount: 2, replyDeleted: slots(".x"),
      hasActivity: true, iActedLast: false,
    });
    expect(result).toBe(1);
    expect(unreadMessageCount({
      readMessageCount: renderReadCount(slots(".x"), result), replyCount: 1,
    })).toBe(1);
  });

  it("clamps a stored boundary above the current total", () => {
    // Tombstones purged out from under us (Google guarantees no retention);
    // clamped to 3, then the no-new-slots rule applies.
    expect(nextReadSlotCount({
      storedCount: 5, oldReplySlotCount: 4, replyDeleted: noTombstones(2),
      hasActivity: true, iActedLast: false,
    })).toBe(2);
  });

  it("clamps without marking unread when there's no activity", () => {
    expect(nextReadSlotCount({
      storedCount: 5, oldReplySlotCount: 4, replyDeleted: noTombstones(2),
      hasActivity: false, iActedLast: false,
    })).toBe(3);
  });

  it("never goes negative on an empty thread", () => {
    expect(nextReadSlotCount({
      storedCount: 0, oldReplySlotCount: 0, replyDeleted: [],
      hasActivity: true, iActedLast: false,
    })).toBe(0);
  });

  it("doesn't disturb the boundary when a reply is deleted below it", () => {
    // Read through r1 (boundary 3). r0 is deleted: the slot count is unchanged,
    // so this is "activity without new slots" and the last live message goes
    // unread — but the messages above it keep their read state.
    const result = nextReadSlotCount({
      storedCount: 3, oldReplySlotCount: 4, replyDeleted: slots("x..."),
      hasActivity: true, iActedLast: false,
    });
    expect(renderReadCount(slots("x..."), result)).toBe(2);
  });
});

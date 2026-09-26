import { describe, it, expect } from "vitest";
import { CommentStatus, CommentType } from "@prisma/client";
import {
  badgeCountTooltip,
  computeFilterCounts,
  matchesAllFilters,
  matchesBadges,
  matchesShowMode,
  modeCountTooltip,
  type BadgeFilters,
  type FilterableComment,
  type FilterContext,
} from "./comment-filters";

type C = FilterableComment & { id: string; deleted?: boolean };

function c(id: string, over: Partial<C> = {}): C {
  return {
    id,
    status: CommentStatus.INBOX,
    resolved: false,
    isThreadAuthor: false,
    isReplyAuthor: false,
    assignedToMe: false,
    mentionedMe: false,
    type: CommentType.COMMENT,
    isStarred: false,
    readMessageCount: 1,
    replyCount: 0,
    ...over,
  };
}

const UNREAD = { readMessageCount: 0 };
const OFF: BadgeFilters = {
  mine: "off", replied: "off", assigned: "off", mentioned: "off", resolved: "off",
  deleted: "off", unread: "off", starred: "off", suggestions: "off",
};
const ctx: FilterContext<C> = { isDeleted: (x) => !!x.deleted, hasAnyDeleted: true };

describe("matchesShowMode", () => {
  it("inbox excludes archived and muted", () => {
    expect(matchesShowMode(c("a"), "inbox")).toBe(true);
    expect(matchesShowMode(c("a", { status: CommentStatus.ARCHIVED }), "inbox")).toBe(false);
    expect(matchesShowMode(c("a", { status: CommentStatus.MUTED }), "inbox")).toBe(false);
  });
  it("open/resolved split on resolved; all takes everything", () => {
    const r = c("a", { resolved: true, status: CommentStatus.ARCHIVED });
    expect(matchesShowMode(r, "open")).toBe(false);
    expect(matchesShowMode(r, "resolved")).toBe(true);
    expect(matchesShowMode(r, "all")).toBe(true);
  });
});

describe("matchesBadges", () => {
  it("ANDs include and exclude filters", () => {
    const f = { ...OFF, mine: "include", unread: "exclude" } as BadgeFilters;
    expect(matchesBadges(c("a", { isThreadAuthor: true }), f, ctx)).toBe(true);
    expect(matchesBadges(c("a", { isThreadAuthor: true, ...UNREAD }), f, ctx)).toBe(false);
    expect(matchesBadges(c("a"), f, ctx)).toBe(false);
  });
  it("ignores the Deleted filter while no comment is deleted", () => {
    const f = { ...OFF, deleted: "include" } as BadgeFilters;
    expect(matchesBadges(c("a"), f, ctx)).toBe(false);
    expect(matchesBadges(c("a"), f, { ...ctx, hasAnyDeleted: false })).toBe(true);
  });
  it("can skip one badge", () => {
    const f = { ...OFF, unread: "include" } as BadgeFilters;
    expect(matchesBadges(c("a"), f, ctx, "unread")).toBe(true);
  });
});

describe("matchesAllFilters", () => {
  it("applies search on top of mode and badges", () => {
    const withSearch = { ...ctx, matchesSearch: (x: C) => x.id === "hit" };
    expect(matchesAllFilters(c("hit"), "inbox", OFF, withSearch)).toBe(true);
    expect(matchesAllFilters(c("miss"), "inbox", OFF, withSearch)).toBe(false);
  });
});

describe("computeFilterCounts", () => {
  const comments = [
    c("1", { ...UNREAD, isThreadAuthor: true }),
    c("2", { ...UNREAD }),
    c("3", { isThreadAuthor: true }),
    c("4", { ...UNREAD, status: CommentStatus.ARCHIVED }),
    c("5", { resolved: true, status: CommentStatus.ARCHIVED, isStarred: true }),
  ];

  it("shown counts use only the current mode, ignoring other badges", () => {
    const f = { ...OFF, mine: "include" } as BadgeFilters;
    const { badges } = computeFilterCounts(comments, "inbox", f, ctx);
    expect(badges.unread.shown).toBe(2);
    expect(badges.mine.shown).toBe(2);
    expect(badges.starred.shown).toBe(0);
  });

  it("filtered counts apply other badges but skip the badge's own filter", () => {
    const f = { ...OFF, mine: "include", unread: "exclude" } as BadgeFilters;
    const { badges } = computeFilterCounts(comments, "inbox", f, ctx);
    // Unread, mine, in inbox: #1 (its own "exclude" is skipped).
    expect(badges.unread.filtered).toBe(1);
    // Mine, read, in inbox: #3.
    expect(badges.mine.filtered).toBe(1);
  });

  it("filtered counts apply search", () => {
    const { badges } = computeFilterCounts(comments, "inbox", OFF, {
      ...ctx, matchesSearch: (x) => x.id === "2",
    });
    expect(badges.unread.shown).toBe(2);
    expect(badges.unread.filtered).toBe(1);
  });

  it("counts each badge per show mode", () => {
    const { badges } = computeFilterCounts(comments, "inbox", OFF, ctx);
    expect(badges.unread.byMode).toEqual({ inbox: 2, open: 3, all: 3 });
    expect(badges.starred.byMode).toEqual({ inbox: 0, open: 0, all: 1 });
  });

  it("mode counts give totals and badge+search filtered counts", () => {
    const f = { ...OFF, unread: "include" } as BadgeFilters;
    const { modes } = computeFilterCounts(comments, "inbox", f, ctx);
    expect(modes.inbox).toEqual({ total: 3, filtered: 2 });
    expect(modes.open).toEqual({ total: 4, filtered: 3 });
    expect(modes.all).toEqual({ total: 5, filtered: 3 });
  });
});

describe("tooltips", () => {
  it("badge tooltip lists only counts that differ from the shown one", () => {
    expect(badgeCountTooltip({ shown: 2, filtered: 2, byMode: { inbox: 2, open: 2, all: 2 } }, "inbox"))
      .toEqual(["2 in Inbox"]);
    expect(badgeCountTooltip({ shown: 2, filtered: 1, byMode: { inbox: 2, open: 3, all: 4 } }, "inbox"))
      .toEqual(["2 in Inbox", "3 in Open", "4 in All", "1 with current filters"]);
    expect(badgeCountTooltip({ shown: 3, filtered: 3, byMode: { inbox: 2, open: 3, all: 3 } }, "open"))
      .toEqual(["3 in Open", "2 in Inbox", "3 in All"]);
  });
  it("mode tooltip adds the filtered count only when different", () => {
    expect(modeCountTooltip({ total: 5, filtered: 5 })).toEqual(["5 total"]);
    expect(modeCountTooltip({ total: 5, filtered: 2 })).toEqual(["5 total", "2 with current filters"]);
  });
});

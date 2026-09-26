import { CommentStatus, CommentType, type Comment } from "@prisma/client";
import type { TriState } from "@/lib/tri-state";
import { isThreadRead } from "@/lib/read-state";

/** The comment page's view selector. "resolved" has no button but is a valid state. */
export type ShowMode = "inbox" | "open" | "resolved" | "all";
/** The show modes that have a button in the filter bar, and so get counts. */
export const COUNTED_SHOW_MODES = ["inbox", "open", "all"] as const;
export type CountedShowMode = (typeof COUNTED_SHOW_MODES)[number];

export type BadgeKey =
  | "mine" | "replied" | "assigned" | "mentioned" | "resolved"
  | "deleted" | "unread" | "starred" | "suggestions";
export const BADGE_KEYS: readonly BadgeKey[] = [
  "mine", "replied", "assigned", "mentioned", "resolved",
  "deleted", "unread", "starred", "suggestions",
];
export type BadgeFilters = Record<BadgeKey, TriState>;

/** Fields the filters read; a subset of the Prisma Comment. */
export type FilterableComment = Pick<
  Comment,
  | "status" | "resolved" | "isThreadAuthor" | "isReplyAuthor" | "assignedToMe"
  | "mentionedMe" | "type" | "isStarred" | "readMessageCount" | "replyCount"
>;

/** Page state the filters need that isn't on the comment row itself. */
export interface FilterContext<C> {
  /** Extension-reported "anchored text deleted" state (lives in the thread map). */
  isDeleted: (c: C) => boolean;
  /** The Deleted filter is ignored while hidden, so a stale "include" can't
   *  blank the table with no visible way to clear it. */
  hasAnyDeleted: boolean;
  /** Search box match; omit when the search box is empty. */
  matchesSearch?: (c: C) => boolean;
}

export function matchesShowMode(c: FilterableComment, mode: ShowMode): boolean {
  switch (mode) {
    case "inbox": return c.status !== CommentStatus.ARCHIVED && c.status !== CommentStatus.MUTED;
    case "open": return !c.resolved;
    case "resolved": return c.resolved;
    case "all": return true;
  }
}

/** Whether the comment has the attribute a badge filters on. */
export function hasBadge<C extends FilterableComment>(c: C, key: BadgeKey, ctx: FilterContext<C>): boolean {
  switch (key) {
    case "mine": return c.isThreadAuthor;
    case "replied": return c.isReplyAuthor;
    case "assigned": return c.assignedToMe;
    case "mentioned": return c.mentionedMe;
    case "resolved": return c.resolved;
    case "deleted": return ctx.isDeleted(c);
    case "unread": return !isThreadRead(c);
    case "starred": return c.isStarred;
    case "suggestions": return c.type === CommentType.SUGGESTION;
  }
}

/** True when the comment passes every badge filter (AND), optionally skipping one. */
export function matchesBadges<C extends FilterableComment>(
  c: C, filters: BadgeFilters, ctx: FilterContext<C>, skip?: BadgeKey,
): boolean {
  for (const key of BADGE_KEYS) {
    if (key === skip) continue;
    const f = filters[key];
    if (f === "off") continue;
    if (key === "deleted" && !ctx.hasAnyDeleted) continue;
    if (hasBadge(c, key, ctx) !== (f === "include")) return false;
  }
  return true;
}

/** Full filter: show mode, badges, and search. */
export function matchesAllFilters<C extends FilterableComment>(
  c: C, showMode: ShowMode, filters: BadgeFilters, ctx: FilterContext<C>,
): boolean {
  return matchesShowMode(c, showMode)
    && matchesBadges(c, filters, ctx)
    && (!ctx.matchesSearch || ctx.matchesSearch(c));
}

export interface BadgeCount {
  /** The displayed count: comments with this attribute in the current show
   *  mode, ignoring other badges and search, so it stays stable while toggling
   *  filters (e.g. "Unread: 3" always means 3 unread threads left in Inbox). */
  shown: number;
  /** Comments with this attribute that pass all *other* current filters
   *  (show mode, other badges, search). This badge's own filter is skipped, or
   *  "exclude" would always zero it. */
  filtered: number;
  /** The `shown` count under each show-mode button. */
  byMode: Record<CountedShowMode, number>;
}

export interface ModeCount {
  /** Comments in this mode, ignoring badges and search (matches the main page counts). */
  total: number;
  /** Comments in this mode that pass the current badges and search. */
  filtered: number;
}

export interface FilterCounts {
  badges: Record<BadgeKey, BadgeCount>;
  modes: Record<CountedShowMode, ModeCount>;
}

export function computeFilterCounts<C extends FilterableComment>(
  comments: readonly C[], showMode: ShowMode, filters: BadgeFilters, ctx: FilterContext<C>,
): FilterCounts {
  const zeroModes = () => ({ inbox: 0, open: 0, all: 0 });
  const badges = Object.fromEntries(
    BADGE_KEYS.map((k) => [k, { shown: 0, filtered: 0, byMode: zeroModes() }]),
  ) as Record<BadgeKey, BadgeCount>;
  const modes = {
    inbox: { total: 0, filtered: 0 },
    open: { total: 0, filtered: 0 },
    all: { total: 0, filtered: 0 },
  };

  for (const c of comments) {
    const inCurrentMode = matchesShowMode(c, showMode);
    const matchesSearch = !ctx.matchesSearch || ctx.matchesSearch(c);
    const passesBadges = matchesBadges(c, filters, ctx);
    const inMode = Object.fromEntries(
      COUNTED_SHOW_MODES.map((m) => [m, matchesShowMode(c, m)]),
    ) as Record<CountedShowMode, boolean>;

    for (const m of COUNTED_SHOW_MODES) {
      if (!inMode[m]) continue;
      modes[m].total++;
      if (passesBadges && matchesSearch) modes[m].filtered++;
    }

    for (const key of BADGE_KEYS) {
      if (!hasBadge(c, key, ctx)) continue;
      const b = badges[key];
      if (inCurrentMode) b.shown++;
      for (const m of COUNTED_SHOW_MODES) if (inMode[m]) b.byMode[m]++;
      if (inCurrentMode && matchesSearch && matchesBadges(c, filters, ctx, key)) b.filtered++;
    }
  }
  return { badges, modes };
}

/** How each mode reads in "N in ..." tooltip lines. */
const MODE_LABELS: Record<ShowMode, string> = {
  inbox: "Inbox", open: "Open", resolved: "Resolved", all: "All",
};

/** Tooltip lines for a badge count: the current mode first, then the other
 *  modes, then the filtered count last. The other modes are listed only when
 *  some differ, and the filtered count only when it differs, so an unfiltered
 *  view keeps a short tooltip. */
export function badgeCountTooltip(count: BadgeCount, showMode: ShowMode): string[] {
  const lines = [`${count.shown} in ${MODE_LABELS[showMode]}`];
  const others = COUNTED_SHOW_MODES.filter((m) => m !== showMode);
  if (others.some((m) => count.byMode[m] !== count.shown)) {
    for (const m of others) lines.push(`${count.byMode[m]} in ${MODE_LABELS[m]}`);
  }
  if (count.filtered !== count.shown) lines.push(`${count.filtered} with current filters`);
  return lines;
}

/** Tooltip lines for a show-mode button count. */
export function modeCountTooltip(count: ModeCount): string[] {
  const lines = [`${count.total} total`];
  if (count.filtered !== count.total) lines.push(`${count.filtered} with current filters`);
  return lines;
}

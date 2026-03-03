export const ROLE_COLORS = {
  AUTHOR: {
    badge: "bg-blue-100 text-blue-700",
    activeFilter: "bg-blue-600 text-white",
    inactiveFilter: "bg-blue-50 text-blue-400 hover:bg-blue-100",
  },
  REVIEWER: {
    badge: "bg-violet-100 text-violet-700",
    activeFilter: "bg-violet-600 text-white",
    inactiveFilter: "bg-violet-50 text-violet-400 hover:bg-violet-100",
  },
} as const;

export const STATUS_COLORS = {
  INBOX: {
    badge: "bg-emerald-100 text-emerald-700",
    activeFilter: "bg-emerald-600 text-white",
    inactiveFilter: "bg-emerald-50 text-emerald-400 hover:bg-emerald-100",
  },
  ARCHIVED: {
    badge: "bg-zinc-100 text-zinc-700",
    activeFilter: "bg-zinc-600 text-white",
    inactiveFilter: "bg-zinc-50 text-zinc-400 hover:bg-zinc-100",
  },
} as const;

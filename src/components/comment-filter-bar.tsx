"use client";

type ShowMode = "active" | "open" | "all";
interface CommentFilterBarProps {
  myThreadsFilter: boolean;
  myCommentsFilter: boolean;
  showMode: ShowMode;
  suggestionsOnly: boolean;
  searchFilter: string;
  onMyThreadsChange: (v: boolean) => void;
  onMyCommentsChange: (v: boolean) => void;
  onShowModeChange: (v: ShowMode) => void;
  onSuggestionsOnlyChange: (v: boolean) => void;
  onSearchFilterChange: (v: string) => void;
}

export function CommentFilterBar({
  myThreadsFilter,
  myCommentsFilter,
  showMode,
  suggestionsOnly,
  searchFilter,
  onMyThreadsChange,
  onMyCommentsChange,
  onShowModeChange,
  onSuggestionsOnlyChange,
  onSearchFilterChange,
}: CommentFilterBarProps) {
  function toggleBtn(active: boolean, label: string, onClick: () => void, title?: string) {
    return (
      <button
        onClick={onClick}
        title={title}
        className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
          active
            ? "bg-zinc-800 text-white"
            : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <fieldset className="rounded-lg border border-zinc-200 px-4 py-2">
      <legend className="px-1 text-xs font-medium text-zinc-400 uppercase tracking-wide">
        Filters
      </legend>
      <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">

        {toggleBtn(myThreadsFilter, "My threads", () => onMyThreadsChange(!myThreadsFilter), "Threads I participated in")}
        {toggleBtn(myCommentsFilter, "My comments", () => onMyCommentsChange(!myCommentsFilter), "Threads I started")}
        {toggleBtn(suggestionsOnly, "Suggestions", () => onSuggestionsOnlyChange(!suggestionsOnly), "Show suggestions")}

        <div className="h-4 w-px bg-zinc-200" />

        <div className="flex items-center gap-1">
          {(["active", "open", "all"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onShowModeChange(mode)}
              title={{ active: "Show unarchived comments", open: "Show all unresolved comments", all: "Show all comments including resolved" }[mode]}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                showMode === mode
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-zinc-400">Search</span>
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => onSearchFilterChange(e.target.value)}
          placeholder="regex filter…"
          className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 placeholder:text-zinc-300 focus:border-zinc-400 focus:outline-none w-90"
        />
      </div>
      </div>
    </fieldset>
  );
}

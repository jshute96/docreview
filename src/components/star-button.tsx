"use client";

import { Star } from "lucide-react";
import type { TriState } from "@/lib/tri-state";
import { useTriStateCycle, DiagonalStrike } from "@/components/tri-state-button";

// ---------------------------------------------------------------------------
// StarButton — toggle star on/off for a single doc or comment
// ---------------------------------------------------------------------------

interface StarButtonProps {
  starred: boolean;
  onToggle: () => void;
  className?: string;
}

export function StarButton({ starred, onToggle, className = "" }: StarButtonProps) {
  return (
    <button
      onClick={onToggle}
      title={starred ? "Starred" : "Not starred"}
      className={`inline-flex items-center justify-center transition-colors ${className}`}
    >
      <Star
        className={`h-4 w-4 ${starred ? "text-amber-400" : "text-zinc-300 hover:text-zinc-400"}`}
        fill={starred ? "currentColor" : "none"}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriStateStarButton — tri-state filter: off / include / exclude
// ---------------------------------------------------------------------------

interface TriStateStarButtonProps {
  value: TriState;
  onChange: (v: TriState) => void;
}

export function TriStateStarButton({ value, onChange }: TriStateStarButtonProps) {
  const handleClick = useTriStateCycle(value, onChange);
  const stateClass =
    value === "include"
      ? "text-amber-400"
      : value === "exclude"
        ? "text-amber-400"
        : "text-zinc-300 hover:text-zinc-400";

  return (
    <button
      onClick={handleClick}
      title="Filter by starred"
      className={`relative overflow-hidden rounded p-0.5 transition-colors ${stateClass}`}
    >
      <Star
        className="h-4 w-4"
        fill={value === "off" ? "none" : "currentColor"}
      />
      {value === "exclude" && <DiagonalStrike bgColor="#fafafa" />}
    </button>
  );
}

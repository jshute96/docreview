"use client";

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Bright primary row on top, then a dark-to-light gradient below
//   red      orange   yellow   green    teal     blue     purple   pink
const PRIMARY_ROW = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#d946ef"];

const GRADIENT_ROWS = [
  // 200
  ["#fecaca", "#fed7aa", "#fef08a", "#bbf7d0", "#a5f3fc", "#bfdbfe", "#ddd6fe", "#f5d0fe"],
  // 400
  ["#f87171", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#e879f9"],
  // 600
  ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#c026d3"],
  // 800
  ["#991b1b", "#9a3412", "#854d0e", "#166534", "#155e75", "#1e40af", "#5b21b6", "#86198f"],
];

// The "primary" row used for random assignment on new labels
export const PRIMARY_COLORS = PRIMARY_ROW;

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  children: React.ReactNode;
}

function ColorCell({ color, selected, onSelect }: { color: string; selected: boolean; onSelect: (c: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(color)}
      className={`block transition-opacity hover:opacity-75 ${
        selected ? "ring-2 ring-inset ring-white" : ""
      }`}
      style={{ width: 20, height: 20, backgroundColor: color }}
      aria-label={`Color ${color}`}
    />
  );
}

export function ColorPicker({ color, onChange, children }: ColorPickerProps) {
  const [open, setOpen] = useState(false);

  function select(c: string) {
    onChange(c);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-auto p-0 bg-white border border-zinc-200 shadow-lg" align="start">
        <table
          cellSpacing={0}
          cellPadding={0}
          style={{ borderCollapse: "collapse", border: "2px solid #18181b" }}
        >
          <tbody>
            {/* Bright primary row */}
            <tr>
              {PRIMARY_ROW.map((c) => (
                <td key={c} style={{ padding: 0, border: "1px solid #18181b" }}>
                  <ColorCell color={c} selected={color === c} onSelect={select} />
                </td>
              ))}
            </tr>
            {/* 2px separator */}
            <tr>
              <td colSpan={PRIMARY_ROW.length} style={{ height: 2, padding: 0, backgroundColor: "#18181b" }} />
            </tr>
            {/* Dark-to-light gradient */}
            {GRADIENT_ROWS.map((row, ri) => (
              <tr key={ri}>
                {row.map((c) => (
                  <td key={c} style={{ padding: 0, border: "1px solid #18181b" }}>
                    <ColorCell color={c} selected={color === c} onSelect={select} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}

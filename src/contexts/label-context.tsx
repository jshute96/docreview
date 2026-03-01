"use client";

import { createContext, useContext } from "react";
import type { Label } from "@prisma/client";

interface LabelContextValue {
  allLabels: Label[];
  onLabelsChange: (labels: Label[]) => void;
  onLabelDelete: (id: string) => void;
}

const LabelContext = createContext<LabelContextValue | null>(null);

export function LabelProvider({
  allLabels,
  onLabelsChange,
  onLabelDelete,
  children,
}: LabelContextValue & { children: React.ReactNode }) {
  return (
    <LabelContext.Provider value={{ allLabels, onLabelsChange, onLabelDelete }}>
      {children}
    </LabelContext.Provider>
  );
}

export function useLabels(): LabelContextValue {
  const ctx = useContext(LabelContext);
  if (!ctx) {
    throw new Error("useLabels must be used within a LabelProvider");
  }
  return ctx;
}

/** Progress events sent from server to client during refresh/load operations. */
export type ProgressEvent =
  | { phase: "drive"; status: "reading"; count: number; docsCount?: number; deletedCount?: number }
  | { phase: "drive"; status: "done"; count: number; totalChanges?: number }
  | { phase: "gmail"; status: "reading"; count: number; total?: number }
  | { phase: "gmail"; status: "done"; count: number; errorCount?: number }
  | { phase: "metadata"; completed: number; total: number }
  | { phase: "sync"; completed: number; total: number };

export type OnProgress = (event: ProgressEvent) => void;

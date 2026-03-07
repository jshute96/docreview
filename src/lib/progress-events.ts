/** Progress events sent from server to client during refresh/load operations. */
export type ProgressEvent =
  | { phase: "drive"; status: "reading" }
  | { phase: "drive"; status: "done"; count: number }
  | { phase: "gmail"; status: "reading" }
  | { phase: "gmail"; status: "done"; count: number; errorCount?: number }
  | { phase: "metadata"; count: number }
  | { phase: "sync"; completed: number; total: number };

export type OnProgress = (event: ProgressEvent) => void;

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- Mocks ----------

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("./api-fetch", () => ({
  ApiAuthError: class ApiAuthError extends Error {
    constructor() {
      super("auth");
      this.name = "ApiAuthError";
    }
  },
  generateContextId: () => "ctx12345",
}));

import { toast } from "sonner";
import {
  formatResultParts,
  handleRefreshProgress,
  dismissProgressToasts,
  PROGRESS_DRIVE,
  PROGRESS_GMAIL,
  PROGRESS_SYNC,
  fetchWithProgress,
} from "./stream-progress";
import { ApiAuthError } from "./api-fetch";

const mockToast = toast as unknown as {
  loading: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------- formatResultParts ----------

describe("formatResultParts", () => {
  it("returns 'no updates' summary when all counts are zero/missing", () => {
    expect(formatResultParts({})).toEqual({ summary: "no updates", errorSuffix: "" });
  });

  it("wraps stats in totalDocuments count when provided", () => {
    expect(formatResultParts({ added: 2, updated: 1, totalDocuments: 10 })).toEqual({
      summary: "10 documents (2 new, 1 updated)",
      errorSuffix: "",
    });
  });

  it("omits totalDocuments wrapping when count is 0", () => {
    expect(formatResultParts({ added: 2 })).toEqual({
      summary: "2 new",
      errorSuffix: "",
    });
  });

  it("joins all four count types in canonical order", () => {
    expect(formatResultParts({
      added: 1, updated: 2, deleted: 3, unarchived: 4, totalDocuments: 5,
    })).toEqual({
      summary: "5 documents (1 new, 2 updated, 3 deleted, 4 unarchived)",
      errorSuffix: "",
    });
  });

  it("skips entries with zero counts", () => {
    expect(formatResultParts({ added: 0, updated: 3, totalDocuments: 3 })).toEqual({
      summary: "3 documents (3 updated)",
      errorSuffix: "",
    });
  });

  it("emits errorSuffix when errorCount > 0", () => {
    expect(formatResultParts({ added: 1, errorCount: 2 })).toEqual({
      summary: "1 new",
      errorSuffix: " (2 errors)",
    });
  });

  it("omits errorSuffix when errorCount is 0 or absent", () => {
    expect(formatResultParts({ added: 1, errorCount: 0 }).errorSuffix).toBe("");
  });
});

// ---------- handleRefreshProgress ----------

describe("handleRefreshProgress: drive phase", () => {
  it("shows loading with found count while reading", () => {
    handleRefreshProgress({ phase: "drive", status: "reading", count: 5 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Scanning changes from Drive (5 found)...",
      { id: PROGRESS_DRIVE },
    );
  });

  it("shows plain loading message when count is 0", () => {
    handleRefreshProgress({ phase: "drive", status: "reading", count: 0 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Scanning changes from Drive...",
      { id: PROGRESS_DRIVE },
    );
  });

  it("shows 'no new changes' success when done with 0 docs", () => {
    handleRefreshProgress({ phase: "drive", status: "done", count: 0 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "No new changes from Drive",
      { id: PROGRESS_DRIVE, duration: 4000 },
    );
  });

  it("uses 'changes' label when totalChanges provided", () => {
    handleRefreshProgress({
      phase: "drive", status: "done", count: 3, totalChanges: 7,
    });
    expect(mockToast.success).toHaveBeenCalledWith(
      "Read 7 changes from Drive",
      { id: PROGRESS_DRIVE, duration: 4000 },
    );
  });

  it("uses 'documents' label when totalChanges is undefined", () => {
    handleRefreshProgress({ phase: "drive", status: "done", count: 3 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "Read 3 documents from Drive",
      { id: PROGRESS_DRIVE, duration: 4000 },
    );
  });
});

describe("handleRefreshProgress: gmail phase", () => {
  it("shows 'No Gmail account' warning when noGmailAccount is set", () => {
    handleRefreshProgress({
      phase: "gmail", status: "done", count: 0, noGmailAccount: true,
    });
    expect(mockToast.warning).toHaveBeenCalledWith(
      "No Gmail account",
      { id: PROGRESS_GMAIL, duration: 4000 },
    );
  });

  it("appends error count to success when errorCount > 0", () => {
    handleRefreshProgress({
      phase: "gmail", status: "done", count: 2, errorCount: 1,
    });
    expect(mockToast.warning).toHaveBeenCalledWith(
      "Read 2 changes from Gmail (1 errors)",
      { id: PROGRESS_GMAIL, duration: 4000 },
    );
  });

  it("shows success when done with count > 0 and no errors", () => {
    handleRefreshProgress({ phase: "gmail", status: "done", count: 3 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "Read 3 changes from Gmail",
      { id: PROGRESS_GMAIL, duration: 4000 },
    );
  });

  it("shows 'X of Y' progress while reading with total", () => {
    handleRefreshProgress({ phase: "gmail", status: "reading", count: 2, total: 5 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Reading notifications from Gmail (2 of 5)...",
      { id: PROGRESS_GMAIL },
    );
  });

  it("shows '(X found)' when reading with count but no total", () => {
    handleRefreshProgress({ phase: "gmail", status: "reading", count: 3 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Reading notifications from Gmail (3 found)...",
      { id: PROGRESS_GMAIL },
    );
  });

  it("shows plain reading message when count is 0 and no total", () => {
    handleRefreshProgress({ phase: "gmail", status: "reading", count: 0 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Reading notifications from Gmail...",
      { id: PROGRESS_GMAIL },
    );
  });

  it("shows 'no new changes' when done with 0 count and no noGmailAccount", () => {
    handleRefreshProgress({ phase: "gmail", status: "done", count: 0 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "No new changes from Gmail",
      { id: PROGRESS_GMAIL, duration: 4000 },
    );
  });
});

describe("handleRefreshProgress: no-op branches", () => {
  it("does nothing for the docs-updated phase", () => {
    handleRefreshProgress({ phase: "docs-updated" });
    expect(mockToast.loading).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.warning).not.toHaveBeenCalled();
    expect(mockToast.error).not.toHaveBeenCalled();
  });
});

describe("handleRefreshProgress: metadata/sync phases", () => {
  it("shows loading metadata while completed < total", () => {
    handleRefreshProgress({ phase: "metadata", completed: 3, total: 10 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Fetching metadata for 3 of 10 documents...",
      { id: PROGRESS_SYNC },
    );
  });

  it("shows metadata success when done", () => {
    handleRefreshProgress({ phase: "metadata", completed: 10, total: 10 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "Fetched metadata for 10 documents",
      { id: PROGRESS_SYNC, duration: 2000 },
    );
  });

  it("shows sync-in-progress toast", () => {
    handleRefreshProgress({ phase: "sync", completed: 1, total: 3 });
    expect(mockToast.loading).toHaveBeenCalledWith(
      "Reading comments for 1 of 3 documents...",
      { id: PROGRESS_SYNC },
    );
  });

  it("shows sync success when done", () => {
    handleRefreshProgress({ phase: "sync", completed: 3, total: 3 });
    expect(mockToast.success).toHaveBeenCalledWith(
      "Synced 3 documents",
      { id: PROGRESS_SYNC, duration: 4000 },
    );
  });
});

// ---------- dismissProgressToasts ----------

describe("dismissProgressToasts", () => {
  it("dismisses all three progress toasts by default", () => {
    dismissProgressToasts();
    expect(mockToast.dismiss).toHaveBeenCalledWith(PROGRESS_DRIVE);
    expect(mockToast.dismiss).toHaveBeenCalledWith(PROGRESS_GMAIL);
    expect(mockToast.dismiss).toHaveBeenCalledWith(PROGRESS_SYNC);
    expect(mockToast.dismiss).toHaveBeenCalledTimes(3);
  });

  it("skips toasts listed in keep", () => {
    dismissProgressToasts({ keep: [PROGRESS_DRIVE] });
    expect(mockToast.dismiss).not.toHaveBeenCalledWith(PROGRESS_DRIVE);
    expect(mockToast.dismiss).toHaveBeenCalledWith(PROGRESS_GMAIL);
    expect(mockToast.dismiss).toHaveBeenCalledWith(PROGRESS_SYNC);
  });
});

// ---------- fetchWithProgress ----------

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("fetchWithProgress", () => {
  it("reads progress events and returns the final result", async () => {
    const body = sseStream([
      `event: progress\ndata: {"phase":"drive","status":"reading","count":2}\n\n`,
      `event: progress\ndata: {"phase":"drive","status":"done","count":2}\n\n`,
      `event: result\ndata: {"ok":true,"added":2}\n\n`,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const events: unknown[] = [];
    const result = await fetchWithProgress<{ ok: boolean; added: number }>(
      "/api/refresh",
      { method: "POST", contextId: "ctx" },
      (e) => events.push(e),
    );
    expect(result).toEqual({ ok: true, added: 2 });
    expect(events).toHaveLength(2);

    // Verify x-context-id header is set from the provided contextId
    const call = fetchSpy.mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-context-id")).toBe("ctx");
    fetchSpy.mockRestore();
  });

  it("generates a contextId when none is provided", async () => {
    const body = sseStream([
      `event: result\ndata: {"ok":true}\n\n`,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await fetchWithProgress("/api/refresh", {}, () => {});
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-context-id")).toBe("ctx12345"); // from mocked generateContextId
    fetchSpy.mockRestore();
  });

  it("throws 'Request failed: N' for non-401 non-ok responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 500 }),
    );
    await expect(
      fetchWithProgress("/api/refresh", {}, () => {}),
    ).rejects.toThrow("Request failed: 500");
    fetchSpy.mockRestore();
  });

  it("throws ApiAuthError and shows reauth toast on 401", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expect(
      fetchWithProgress("/api/refresh", {}, () => {}),
    ).rejects.toBeInstanceOf(ApiAuthError);
    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringContaining("Google authorization has expired"),
      expect.objectContaining({ id: "reauth-required" }),
    );
    fetchSpy.mockRestore();
  });

  it("throws when an error event is dispatched mid-stream", async () => {
    const body = sseStream([
      `event: error\ndata: {"message":"boom"}\n\n`,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    await expect(
      fetchWithProgress("/api/refresh", {}, () => {}),
    ).rejects.toThrow("boom");
    fetchSpy.mockRestore();
  });

  it("maps authExpired error events to ApiAuthError + reauth toast", async () => {
    const body = sseStream([
      `event: error\ndata: {"authExpired":true}\n\n`,
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );
    await expect(
      fetchWithProgress("/api/refresh", {}, () => {}),
    ).rejects.toBeInstanceOf(ApiAuthError);
    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringContaining("Google authorization has expired"),
      expect.objectContaining({ id: "reauth-required" }),
    );
    fetchSpy.mockRestore();
  });
});

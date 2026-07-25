import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DocRole, DocStatus } from "@prisma/client";

vi.mock("@/lib/auth-utils", () => ({
  getValidSession: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: { findFirst: vi.fn() },
  },
}));

// logSilent is pulled in by runWithRequestId, not the route itself.
vi.mock("@/lib/log", () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
  logSilent: vi.fn(),
}));

vi.mock("@/lib/sync-comments", () => ({
  unarchiveDocIfNeeded: vi.fn(),
}));

vi.mock("@/lib/extension-suggestion-merge", () => ({
  mergeExtensionSuggestions: vi.fn(),
}));

import { POST } from "./route";
import { getValidSession } from "@/lib/auth-utils";
import { prisma } from "@/lib/prisma";
import { mergeExtensionSuggestions } from "@/lib/extension-suggestion-merge";

const mockSession = vi.mocked(getValidSession) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findFirst: ReturnType<typeof vi.fn> };
const mockMerge = vi.mocked(mergeExtensionSuggestions) as unknown as ReturnType<typeof vi.fn>;

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/docs/d1/extension-suggestions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ docId: "d1" });

const suggestion = {
  id: "AAAB1disco", suggestionType: "Add", status: "open",
  oldText: "", newText: "x", description: "", author: "A",
  isMine: false, timestamp: "", replies: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mockSession.mockResolvedValue({ user: { id: "u1", email: "me@example.com" } });
  mockDoc.findFirst.mockResolvedValue({
    docId: "d1", userId: "u1", googleDocId: "gdoc1",
    driveUrl: "https://docs.google.com/document/d/gdoc1/edit",
    role: DocRole.REVIEWER, status: DocStatus.INBOX,
  });
  mockMerge.mockResolvedValue({
    merged: 0, inserted: 1, updated: 0, resolved: 0, skipped: 0,
    shouldUnarchive: false, comments: [],
  });
});

describe("POST /api/docs/[docId]/extension-suggestions", () => {
  it("returns 401 when not authenticated", async () => {
    mockSession.mockResolvedValue(null);
    const res = await POST(makeReq({ suggestions: [suggestion] }), { params });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the doc isn't the caller's", async () => {
    mockDoc.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ suggestions: [suggestion] }), { params });
    expect(res.status).toBe(404);
  });

  // The client reads `result.skipped` to decide whether the scrape was partial
  // and needs re-fetching. If the field is renamed or dropped, the client
  // silently treats a rejected batch as a clean load and stops retrying — so
  // pin the exact response shape.
  it("surfaces the merge's skipped count in the response", async () => {
    mockMerge.mockResolvedValue({
      merged: 0, inserted: 1, updated: 0, resolved: 0, skipped: 2,
      shouldUnarchive: false, comments: [],
    });
    const res = await POST(makeReq({ suggestions: [suggestion] }), { params });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result.skipped).toBe(2);
  });

  // A batch the server rejects entirely is a transient scrape failure, not a
  // client error — 200 keeps the page on its retry path instead of surfacing
  // an error the user can't act on.
  it("returns 200, not an error status, when every suggestion is skipped", async () => {
    mockMerge.mockResolvedValue({
      merged: 0, inserted: 0, updated: 0, resolved: 0, skipped: 3,
      shouldUnarchive: false, comments: [],
    });
    const res = await POST(makeReq({ suggestions: [suggestion] }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).result.skipped).toBe(3);
  });

  it("returns 400 when no suggestions are provided", async () => {
    const res = await POST(makeReq({ suggestions: [] }), { params });
    expect(res.status).toBe(400);
  });

  it("returns 500 when the merge throws", async () => {
    mockMerge.mockRejectedValue(new Error("boom"));
    const res = await POST(makeReq({ suggestions: [suggestion] }), { params });
    expect(res.status).toBe(500);
  });
});

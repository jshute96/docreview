import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { suppressingErrors } from "@/test-utils";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: { findUnique: vi.fn() },
    comment: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return {
    ...actual,
    getDriveClient: vi.fn(),
    replyToComment: vi.fn(),
    // Runs the wrapped write directly — the viewedByMeTime pin itself needs
    // Drive file mocks these tests don't care about.
    withViewedTimePinned: vi.fn(async (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn()),
  };
});
vi.mock("@/lib/sync-comments", () => ({
  syncSingleComment: vi.fn(),
}));

import { POST } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { replyToComment } from "@/lib/google-drive";
import { syncSingleComment } from "@/lib/sync-comments";
import { OfflineModeError } from "@/lib/offline";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockComment = prisma.comment as unknown as { findFirst: ReturnType<typeof vi.fn> };

const DOC = { docId: "d1", userId: "u1", googleDocId: "gdoc1" };
const COMMENT_RECORD = { commentId: "c1", docId: "d1", googleCommentId: "disco1", type: "COMMENT" };

function driveError(code: number) {
  return Object.assign(new Error(`code ${code}`), { code });
}

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/docs/d1/threads/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ docId: "d1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "me@example.com" } });
  mockDoc.findUnique.mockResolvedValue(DOC);
  mockComment.findFirst.mockResolvedValue(COMMENT_RECORD);
  vi.mocked(syncSingleComment).mockResolvedValue({
    comment: COMMENT_RECORD,
    thread: { id: "disco1", author: "A", fromMe: true, content: "hi", createdTime: "", resolved: false, replies: [] },
    created: false,
    updated: true,
    deleted: false,
    shouldUnarchive: false,
  } as unknown as Awaited<ReturnType<typeof syncSingleComment>>);
});

describe("POST /api/docs/[docId]/threads/reply", () => {
  it("posts a reply and returns the refreshed thread", async () => {
    const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.threads["disco1"]).toBeDefined();
    expect(replyToComment).toHaveBeenCalled();
  });

  it("returns 403 with Drive's reason when commenting is not permitted", async () => {
    vi.mocked(replyToComment).mockRejectedValue(driveError(403));
    const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/permission/i);
  });

  it("returns 404 when the comment no longer exists", async () => {
    vi.mocked(replyToComment).mockRejectedValue(driveError(404));
    const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no longer exists/i);
  });

  it("reports a post-write read failure as saved, not failed", async () => {
    // The reply lands, then reading it back is denied — telling the user this
    // "failed" would make them post the same reply twice.
    vi.mocked(syncSingleComment).mockResolvedValue({
      comment: COMMENT_RECORD, created: false, updated: false, deleted: false,
      shouldUnarchive: false, permissionDenied: true,
    } as unknown as Awaited<ReturnType<typeof syncSingleComment>>);

    await suppressingErrors(async () => {
      const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/was posted/i);
    });
  });

  it("reports a 403 raised after the write as saved, not as a permission error", async () => {
    vi.mocked(replyToComment).mockResolvedValue(undefined as unknown as void);
    vi.mocked(syncSingleComment).mockRejectedValue(driveError(403));

    await suppressingErrors(async () => {
      const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/was posted/i);
    });
  });

  it("returns 503 in offline mode", async () => {
    vi.mocked(replyToComment).mockRejectedValue(new OfflineModeError("offline"));
    const res = await POST(makeReq({ commentId: "disco1", content: "hello" }), params);
    expect(res.status).toBe(503);
  });
});

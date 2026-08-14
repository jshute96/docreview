import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    doc: { findUnique: vi.fn() },
    comment: { findFirst: vi.fn(), delete: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ comment: { delete: vi.fn() } })
    ),
  },
}));
vi.mock("@/lib/google-drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-drive")>("@/lib/google-drive");
  return {
    ...actual,
    getDriveClient: vi.fn(),
    editComment: vi.fn(),
    editReply: vi.fn(),
    deleteComment: vi.fn(),
    deleteReply: vi.fn(),
    // The viewedByMeTime pin is exercised by the reply route; here it just runs
    // the wrapped write so these tests don't need Drive file mocks.
    withViewedTimePinned: vi.fn(async (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn()),
  };
});
vi.mock("@/lib/sync-comments", () => ({
  syncSingleComment: vi.fn(),
  bumpLastCommentActivity: vi.fn(),
}));

import { PATCH, DELETE } from "./route";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { editComment, editReply, deleteComment, deleteReply } from "@/lib/google-drive";
import { syncSingleComment } from "@/lib/sync-comments";

const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>;
const mockDoc = prisma.doc as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mockComment = prisma.comment as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const DOC = { docId: "d1", userId: "u1", googleDocId: "gdoc1" };
const COMMENT_RECORD = { commentId: "c1", docId: "d1", googleCommentId: "disco1", type: "COMMENT" };

function makeParams(docId: string) {
  return { params: Promise.resolve({ docId }) };
}

function makeReq(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/docs/d1/threads/edit", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Drive rejects writes to other people's comments with a 403. */
function driveError(code: number) {
  return Object.assign(new Error(`Drive ${code}`), { code });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "user@example.com" } });
  mockDoc.findUnique.mockResolvedValue(DOC);
  mockComment.findFirst.mockResolvedValue(COMMENT_RECORD);
  vi.mocked(syncSingleComment).mockResolvedValue({
    comment: { commentId: "c1" },
    thread: { id: "disco1", replies: [] },
    created: false,
    updated: true,
    deleted: false,
    shouldUnarchive: false,
  } as unknown as Awaited<ReturnType<typeof syncSingleComment>>);
});

describe("PATCH /api/docs/[docId]/threads/edit", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the doc belongs to another user", async () => {
    mockDoc.findUnique.mockResolvedValue({ ...DOC, userId: "someone-else" });
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(404);
  });

  it("rejects suggestions — the Docs API can't edit them", async () => {
    mockComment.findFirst.mockResolvedValue({ ...COMMENT_RECORD, type: "SUGGESTION" });
    const res = await PATCH(makeReq("PATCH", { commentId: "sug1", content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(400);
    expect(editComment).not.toHaveBeenCalled();
  });

  it("requires non-empty content", async () => {
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: "   " }), makeParams("d1"));
    expect(res.status).toBe(400);
    expect(editComment).not.toHaveBeenCalled();
  });

  it("edits the top-level comment and returns the re-synced thread", async () => {
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: " new text " }), makeParams("d1"));
    expect(res.status).toBe(200);
    expect(editComment).toHaveBeenCalledWith(undefined, "gdoc1", "disco1", "new text");
    expect(editReply).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.threads).toHaveProperty("disco1");
  });

  it("edits a reply when replyId is given", async () => {
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", replyId: "r1", content: "fixed" }), makeParams("d1"));
    expect(res.status).toBe(200);
    expect(editReply).toHaveBeenCalledWith(undefined, "gdoc1", "disco1", "r1", "fixed");
    expect(editComment).not.toHaveBeenCalled();
  });

  it("returns 400 when commentId is missing", async () => {
    const res = await PATCH(makeReq("PATCH", { content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(400);
    expect(editComment).not.toHaveBeenCalled();
  });

  it("returns 400 on a malformed body instead of throwing", async () => {
    const req = new NextRequest("http://localhost/api/docs/d1/threads/edit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await PATCH(req, makeParams("d1"));
    expect(res.status).toBe(400);
  });

  // The write landed, so the user must not be told it failed — repeating it
  // would apply the edit twice.
  it("reports a post-write sync failure as saved-but-unread, not as a failed edit", async () => {
    vi.mocked(syncSingleComment).mockRejectedValue(driveError(404));
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: "hi" }), makeParams("d1"));
    expect(editComment).toHaveBeenCalled();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/was saved/i);
  });

  it("says 'replies' when a reply edit is refused", async () => {
    vi.mocked(editReply).mockRejectedValue(driveError(403));
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", replyId: "r1", content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/your own replies/i);
  });

  // The user's own edit bumps Drive's modifiedTime; the sync must be told so it
  // doesn't read that as activity and pull an archived comment back to INBOX.
  it("marks the re-sync as a self-edit", async () => {
    await PATCH(makeReq("PATCH", { commentId: "disco1", content: "typo fixed" }), makeParams("d1"));
    expect(syncSingleComment).toHaveBeenCalledWith(
      DOC,
      "disco1",
      undefined,
      expect.objectContaining({ selfEdited: true })
    );
    // The status comes straight from the single sync write — no second update
    // to walk one back.
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("maps a Drive 403 to 403 with an ownership message", async () => {
    vi.mocked(editComment).mockRejectedValue(driveError(403));
    const res = await PATCH(makeReq("PATCH", { commentId: "disco1", content: "hi" }), makeParams("d1"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/your own comments/i);
  });
});

describe("DELETE /api/docs/[docId]/threads/edit", () => {
  it("deletes the whole thread and drops the DB record", async () => {
    const res = await DELETE(makeReq("DELETE", { commentId: "disco1" }), makeParams("d1"));
    expect(res.status).toBe(200);
    expect(deleteComment).toHaveBeenCalledWith(undefined, "gdoc1", "disco1");
    expect(await res.json()).toEqual({ deleted: true });
    // The row is gone, so there is nothing left to re-sync from Drive.
    expect(syncSingleComment).not.toHaveBeenCalled();
  });

  it("marks a reply delete as a self-edit too", async () => {
    await DELETE(makeReq("DELETE", { commentId: "disco1", replyId: "r1" }), makeParams("d1"));
    expect(syncSingleComment).toHaveBeenCalledWith(
      DOC,
      "disco1",
      undefined,
      expect.objectContaining({ selfEdited: true })
    );
    expect(mockComment.update).not.toHaveBeenCalled();
  });

  it("deletes a single reply and re-syncs the surviving thread", async () => {
    const res = await DELETE(makeReq("DELETE", { commentId: "disco1", replyId: "r1" }), makeParams("d1"));
    expect(res.status).toBe(200);
    expect(deleteReply).toHaveBeenCalledWith(undefined, "gdoc1", "disco1", "r1");
    expect(deleteComment).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.comment).toEqual({ commentId: "c1" });
    expect(data.threads).toHaveProperty("disco1");
  });

  it("rejects suggestions", async () => {
    mockComment.findFirst.mockResolvedValue({ ...COMMENT_RECORD, type: "SUGGESTION" });
    const res = await DELETE(makeReq("DELETE", { commentId: "sug1" }), makeParams("d1"));
    expect(res.status).toBe(400);
    expect(deleteComment).not.toHaveBeenCalled();
  });

  it("maps a Drive 404 to 404 — the comment is already gone", async () => {
    vi.mocked(deleteComment).mockRejectedValue(driveError(404));
    const res = await DELETE(makeReq("DELETE", { commentId: "disco1" }), makeParams("d1"));
    expect(res.status).toBe(404);
  });
});

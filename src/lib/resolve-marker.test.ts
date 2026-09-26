import { describe, it, expect } from "vitest";
import { inferredResolvedPosition } from "./resolve-marker";

describe("inferredResolvedPosition", () => {
  it("is null for unresolved threads", () => {
    expect(inferredResolvedPosition(false, [])).toBeNull();
  });
  it("tags the head when a resolved thread has no replies", () => {
    expect(inferredResolvedPosition(true, [])).toBe(0);
  });
  it("tags the last reply when no reply closed the thread", () => {
    expect(inferredResolvedPosition(true, [{}, {}])).toBe(2);
  });
  it("is null when a reply resolved, accepted, or rejected the thread", () => {
    expect(inferredResolvedPosition(true, [{}, { action: "resolve" }])).toBeNull();
    expect(inferredResolvedPosition(true, [{ action: "accept" }])).toBeNull();
    expect(inferredResolvedPosition(true, [{ action: "reject" }, {}])).toBeNull();
  });
  it("tags the end when the latest action is a reopen", () => {
    expect(inferredResolvedPosition(true, [{ action: "resolve" }, { action: "reopen" }])).toBe(2);
  });
});

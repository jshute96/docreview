import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// bridge-to-extension.ts uses window.postMessage to talk to the Chrome
// extension. We set up a minimal window stub that captures outgoing messages
// and exposes a helper to deliver canned responses via the registered
// listener. This lets us test the promise-based request/response flow without
// a real DOM.

type Listener = (event: MessageEvent) => void;

interface MockWindow {
  addEventListener: (name: string, fn: Listener) => void;
  removeEventListener: (name: string, fn: Listener) => void;
  postMessage: (msg: unknown) => void;
  open: ReturnType<typeof vi.fn>;
  listeners: Listener[];
  outbound: unknown[];
  /** Deliver a response event to all registered message listeners. */
  respond: (data: Record<string, unknown>) => void;
}

function makeMockWindow(): MockWindow {
  const listeners: Listener[] = [];
  const outbound: unknown[] = [];
  const win: MockWindow = {
    listeners,
    outbound,
    addEventListener: (name, fn) => {
      if (name === "message") listeners.push(fn);
    },
    removeEventListener: (name, fn) => {
      if (name !== "message") return;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    postMessage: (msg) => { outbound.push(msg); },
    open: vi.fn(),
    respond: (data) => {
      const evt = { data } as MessageEvent;
      for (const fn of [...listeners]) fn(evt);
    },
  };
  return win;
}

function outboundOf(win: MockWindow, type: string) {
  return (win.outbound as Array<Record<string, unknown>>).filter(m => m.type === type);
}

let win: MockWindow;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  // Module logs diagnostic messages via raw console.log (extension diagnostics,
  // not server-side app code) — mute them during tests to keep output readable.
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  win = makeMockWindow();
  vi.stubGlobal("window", win);
  // BroadcastChannel — not exercised by these tests but bridge imports
  // reference it via commentSynced listener setup at module load.
  vi.stubGlobal("BroadcastChannel", class {
    constructor(_name: string) {}
    postMessage() {}
    close() {}
    addEventListener() {}
  });
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------- pingExtension ----------

describe("pingExtension", () => {
  it("resolves cached status on valid response", async () => {
    const mod = await import("./bridge-to-extension");
    const status = { version: 2, baseUrl: "http://localhost:3000", enableDocs: true, enableResolve: false, resolveHosts: [] };
    const promise = mod.pingExtension();

    // The module posts an outgoing ping; grab its id and simulate a reply.
    const out = win.outbound[0] as { id: number; type: string };
    expect(out.type).toBe("ping");
    win.respond({ source: "docreview-extension", id: out.id, response: status });

    const result = await promise;
    expect(result).toEqual(status);
    expect(mod.getExtensionStatus()).toEqual(status);
  });

  it("resolves null on timeout (no response)", async () => {
    const mod = await import("./bridge-to-extension");
    const promise = mod.pingExtension();
    // Ignore unhandled rejection from the inner sendExtensionMessage — pingExtension catches it
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;
    expect(result).toBeNull();
    expect(mod.getExtensionStatus()).toBeNull();
  });

  it("resolves null when extension sends an error", async () => {
    const mod = await import("./bridge-to-extension");
    const promise = mod.pingExtension();
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, error: "nope" });
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ---------- supportsCommentNavigation ----------

describe("supportsCommentNavigation", () => {
  it("returns false when no status cached", async () => {
    const mod = await import("./bridge-to-extension");
    expect(mod.supportsCommentNavigation()).toBe(false);
  });

  it("returns false when version < 2", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.pingExtension();
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { version: 1, baseUrl: "", enableDocs: true, enableResolve: false, resolveHosts: [] },
    });
    await p;
    expect(mod.supportsCommentNavigation()).toBe(false);
  });

  it("returns false when version >= 2 but enableDocs is false", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.pingExtension();
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { version: 2, baseUrl: "", enableDocs: false, enableResolve: false, resolveHosts: [] },
    });
    await p;
    expect(mod.supportsCommentNavigation()).toBe(false);
  });

  it("returns true only when version >= 2 AND enableDocs", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.pingExtension();
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { version: 3, baseUrl: "", enableDocs: true, enableResolve: false, resolveHosts: [] },
    });
    await p;
    expect(mod.supportsCommentNavigation()).toBe(true);
  });
});

// ---------- resolveUrl ----------

describe("resolveUrl", () => {
  it("adds http:// prefix when URL has no scheme", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.resolveUrl("go/short-name");
    const out = win.outbound[0] as { url: string; id: number };
    expect(out.url).toBe("http://go/short-name");
    win.respond({ source: "docreview-extension", id: out.id, response: { resolved: true, url: "https://docs.google.com/abc" } });
    const result = await p;
    expect(result).toEqual({ resolved: true, url: "https://docs.google.com/abc" });
  });

  it("preserves an existing http:// scheme", async () => {
    const mod = await import("./bridge-to-extension");
    mod.resolveUrl("http://go/x");
    expect((win.outbound[0] as { url: string }).url).toBe("http://go/x");
  });

  it("preserves an existing https:// scheme", async () => {
    const mod = await import("./bridge-to-extension");
    mod.resolveUrl("https://docs.google.com/abc");
    expect((win.outbound[0] as { url: string }).url).toBe("https://docs.google.com/abc");
  });

  it("trims whitespace before checking scheme", async () => {
    const mod = await import("./bridge-to-extension");
    mod.resolveUrl("  go/abc  ");
    expect((win.outbound[0] as { url: string }).url).toBe("http://go/abc");
  });
});

// ---------- cancelResolve ----------

describe("cancelResolve", () => {
  it("posts a fire-and-forget cancelResolve message", async () => {
    const mod = await import("./bridge-to-extension");
    mod.cancelResolve();
    const cancels = outboundOf(win, "cancelResolve");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ type: "cancelResolve", fireAndForget: true });
  });
});

// ---------- focusDocTab ----------

describe("focusDocTab", () => {
  it("returns true when extension reports tab found", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.focusDocTab("gdoc1");
    const out = win.outbound[0] as { id: number; type: string };
    expect(out.type).toBe("focusDocTab");
    win.respond({ source: "docreview-extension", id: out.id, response: { found: true } });
    expect(await p).toBe(true);
  });

  it("returns false when extension reports tab not found", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.focusDocTab("gdoc1");
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, response: { found: false } });
    expect(await p).toBe(false);
  });

  it("returns false when the extension errors", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.focusDocTab("gdoc1");
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, error: "no extension" });
    expect(await p).toBe(false);
  });

  it("returns false when extension does not respond in time", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.focusDocTab("gdoc1");
    await vi.advanceTimersByTimeAsync(2100);
    expect(await p).toBe(false);
  });
});

// ---------- getCommentsAndSuggestionsFromDoc ----------

describe("getCommentsAndSuggestionsFromDoc", () => {
  it("returns null when extension reports failure", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getCommentsAndSuggestionsFromDoc("gdoc1");
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, response: { success: false, error: "no tab" } });
    expect(await p).toBeNull();
  });

  it("returns suggestions+comments arrays on success", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getCommentsAndSuggestionsFromDoc("gdoc1");
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: {
        success: true,
        suggestions: [{ id: "AAAB1s" }],
        comments: [{ id: "AAAB1c", originalContentDeleted: false }],
      },
    });
    const result = await p;
    expect(result).toEqual({
      suggestions: [{ id: "AAAB1s" }],
      comments: [{ id: "AAAB1c", originalContentDeleted: false }],
    });
  });

  it("returns null when postMessage throws / rejects", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getCommentsAndSuggestionsFromDoc("gdoc1");
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, error: "boom" });
    expect(await p).toBeNull();
  });
});

// ---------- getSuggestionFromDoc ----------

describe("getSuggestionFromDoc", () => {
  it("returns the suggestion when present", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getSuggestionFromDoc("gdoc1", "AAAB1disco");
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { success: true, suggestion: { id: "AAAB1disco" } },
    });
    expect(await p).toEqual({ id: "AAAB1disco" });
  });

  it("returns null when suggestion not found (success=true, suggestion=null)", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getSuggestionFromDoc("gdoc1", "AAAB1disco");
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { success: true, suggestion: null },
    });
    expect(await p).toBeNull();
  });

  it("throws when success=false", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.getSuggestionFromDoc("gdoc1", "AAAB1disco");
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, response: { success: false, error: "nope" } });
    await expect(p).rejects.toThrow("nope");
  });
});

// ---------- selectCommentInDoc ----------

describe("selectCommentInDoc", () => {
  it("posts a fire-and-forget selectComment message", async () => {
    const mod = await import("./bridge-to-extension");
    mod.selectCommentInDoc("gdoc1", "AAAB1disco");
    const msgs = outboundOf(win, "selectComment");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: "selectComment",
      docId: "gdoc1",
      discoId: "AAAB1disco",
      fireAndForget: true,
    });
  });
});

// ---------- setCommentSelectionHandler / setDocReadyHandler ----------

describe("selection + docReady handlers", () => {
  it("invokes registered comment-selection handler on extension message", async () => {
    const mod = await import("./bridge-to-extension");
    const spy = vi.fn();
    mod.setCommentSelectionHandler(spy);
    win.respond({
      source: "docreview-extension",
      type: "commentSelection",
      docId: "gdoc1",
      discoId: "AAAB1disco",
      selected: true,
    });
    expect(spy).toHaveBeenCalledWith("gdoc1", "AAAB1disco", true);
    mod.setCommentSelectionHandler(null);
  });

  it("ignores messages whose source is not the extension", async () => {
    const mod = await import("./bridge-to-extension");
    const spy = vi.fn();
    mod.setCommentSelectionHandler(spy);
    win.respond({ source: "some-other", type: "commentSelection", docId: "x", discoId: "y", selected: true });
    expect(spy).not.toHaveBeenCalled();
    mod.setCommentSelectionHandler(null);
  });

  it("invokes docReady handler on docReady messages with a docId", async () => {
    const mod = await import("./bridge-to-extension");
    const spy = vi.fn();
    mod.setDocReadyHandler(spy);
    win.respond({ source: "docreview-extension", type: "docReady", docId: "gdoc1" });
    expect(spy).toHaveBeenCalledWith("gdoc1");
    mod.setDocReadyHandler(null);
  });

  it("ignores docReady messages without a docId", async () => {
    const mod = await import("./bridge-to-extension");
    const spy = vi.fn();
    mod.setDocReadyHandler(spy);
    win.respond({ source: "docreview-extension", type: "docReady" });
    expect(spy).not.toHaveBeenCalled();
    mod.setDocReadyHandler(null);
  });

  it("ignores messages from the wrong source in the docReady listener too", async () => {
    const mod = await import("./bridge-to-extension");
    const spy = vi.fn();
    mod.setDocReadyHandler(spy);
    win.respond({ source: "attacker", type: "docReady", docId: "gdoc1" });
    expect(spy).not.toHaveBeenCalled();
    mod.setDocReadyHandler(null);
  });
});

// ---------- navigateToComment ----------

describe("navigateToComment", () => {
  it("posts navigateToComment and resolves to the extension response", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.navigateToComment("gdoc1", "AAAB1disco", "https://docs.google.com/document/d/gdoc1/edit", false);

    const out = win.outbound[0] as Record<string, unknown>;
    expect(out).toMatchObject({
      type: "navigateToComment",
      docId: "gdoc1",
      discoId: "AAAB1disco",
      docUrl: "https://docs.google.com/document/d/gdoc1/edit",
      resolved: false,
    });

    win.respond({
      source: "docreview-extension", id: out.id,
      response: { success: true, opened: true },
    });
    expect(await p).toEqual({ success: true, opened: true });
  });

  it("rejects when extension errors", async () => {
    const mod = await import("./bridge-to-extension");
    const p = mod.navigateToComment("gdoc1", "AAAB1disco", "https://docs.google.com/...", true);
    const out = win.outbound[0] as { id: number };
    win.respond({ source: "docreview-extension", id: out.id, error: "no tab" });
    await expect(p).rejects.toThrow("no tab");
  });
});

// ---------- handleOpenDocClick ----------

describe("handleOpenDocClick", () => {
  it("is a no-op when comment navigation is unsupported", async () => {
    const mod = await import("./bridge-to-extension");
    // No pingExtension call → cached status is null → supportsCommentNavigation=false
    const e = { preventDefault: vi.fn() };
    mod.handleOpenDocClick(e, "gdoc1", "https://docs.google.com/document/d/gdoc1/edit", "doc-gdoc1");
    expect(e.preventDefault).not.toHaveBeenCalled();
    // Should not send any message since the extension isn't available
    expect(win.outbound).toHaveLength(0);
  });

  it("prevents default and calls focusDocTab when extension supports navigation", async () => {
    const mod = await import("./bridge-to-extension");

    // Prime the cached extension status via pingExtension
    const p = mod.pingExtension();
    const out = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: out.id,
      response: { version: 2, baseUrl: "", enableDocs: true, enableResolve: false, resolveHosts: [] },
    });
    await p;

    const e = { preventDefault: vi.fn() };
    mod.handleOpenDocClick(e, "gdoc1", "https://docs.google.com/document/d/gdoc1/edit", "doc-gdoc1");
    expect(e.preventDefault).toHaveBeenCalledOnce();

    // The outgoing focusDocTab request should be the last message posted
    const focus = (win.outbound as Array<Record<string, unknown>>).find(m => m.type === "focusDocTab");
    expect(focus).toMatchObject({ type: "focusDocTab", docId: "gdoc1" });
  });

  it("falls back to window.open when extension reports no matching tab", async () => {
    const mod = await import("./bridge-to-extension");
    // Prime supportsCommentNavigation = true
    const ping = mod.pingExtension();
    const pingOut = win.outbound[0] as { id: number };
    win.respond({
      source: "docreview-extension", id: pingOut.id,
      response: { version: 2, baseUrl: "", enableDocs: true, enableResolve: false, resolveHosts: [] },
    });
    await ping;

    const e = { preventDefault: vi.fn() };
    mod.handleOpenDocClick(e, "gdoc1", "https://docs.google.com/document/d/gdoc1/edit", "doc-gdoc1");

    // Respond to the inner focusDocTab call with { found: false }
    const focus = (win.outbound as Array<Record<string, unknown>>).find(m => m.type === "focusDocTab") as { id: number };
    win.respond({ source: "docreview-extension", id: focus.id, response: { found: false } });

    // Drain microtasks so the .then() handler runs
    await vi.advanceTimersByTimeAsync(0);

    expect(win.open).toHaveBeenCalledWith("https://docs.google.com/document/d/gdoc1/edit", "doc-gdoc1");
  });
});

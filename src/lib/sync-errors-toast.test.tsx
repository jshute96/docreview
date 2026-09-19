import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { showSyncErrorsToast, SYNC_ERRORS_TOAST_ID } from "./sync-errors-toast";

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }));

function renderedDescription(): string {
  const opts = vi.mocked(toast.warning).mock.calls[0][1] as { description: React.ReactElement };
  return renderToStaticMarkup(opts.description);
}

describe("showSyncErrorsToast", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dismisses any earlier warning when there are no errors", () => {
    showSyncErrorsToast([], [], {});
    showSyncErrorsToast(undefined, [], {});
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith(SYNC_ERRORS_TOAST_ID);
  });

  it("lists titled docs as links to their comments page", () => {
    showSyncErrorsToast(["g1"], [{ docId: "d1", googleDocId: "g1" }], { g1: "Q3 Notes" });
    expect(toast.warning).toHaveBeenCalledWith("1 document couldn't be synced", expect.objectContaining({ id: SYNC_ERRORS_TOAST_ID }));
    const html = renderedDescription();
    expect(html).toContain('href="/comments/d1"');
    expect(html).toContain('target="dr-g1"');
    expect(html).toContain("Q3 Notes");
    expect(html).toContain("retried automatically");
  });

  it("uses a shortened ID when the title isn't cached yet", () => {
    showSyncErrorsToast(["abcdefghijk"], [{ docId: "d1", googleDocId: "abcdefghijk" }], {});
    expect(renderedDescription()).toContain("Document abcdefgh…");
  });

  it("tells Load users to retry manually", () => {
    showSyncErrorsToast(["g1"], [], {}, "load");
    const html = renderedDescription();
    expect(html).toContain("Try loading them again");
    expect(html).not.toContain("retried automatically");
  });

  it("dedupes repeated IDs", () => {
    showSyncErrorsToast(["g1", "g1"], [], {});
    expect(toast.warning).toHaveBeenCalledWith("1 document couldn't be synced", expect.anything());
  });

  it("links an untracked doc (no DB row) to Google Docs with a placeholder title", () => {
    showSyncErrorsToast(["abcdefghijk"], [], {});
    const html = renderedDescription();
    expect(html).toContain("docs.google.com/document/d/abcdefghijk");
    expect(html).toContain('target="doc-abcdefghijk"');
    expect(html).toContain("Document abcdefgh…");
  });

  it("caps the list at 5 and reports the remainder", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    showSyncErrorsToast(ids, ids.map(id => ({ docId: `d-${id}`, googleDocId: id })), Object.fromEntries(ids.map(id => [id, `Doc ${id}`])));
    expect(toast.warning).toHaveBeenCalledWith("7 documents couldn't be synced", expect.anything());
    const html = renderedDescription();
    expect(html).toContain("Doc e");
    expect(html).not.toContain("Doc f");
    expect(html).toContain("…and 2 more");
  });
});

import { describe, it, expect } from "vitest";
import { filterDocs, sortDocs } from "./doc-filters";
import type { FilterOptions } from "./doc-filters";
import type { DocWithLabels } from "@/types";

// Helper to build a minimal DocWithLabels for testing
function makeDoc(overrides: Partial<DocWithLabels> & { title: string }): DocWithLabels {
  return {
    docId: overrides.docId ?? overrides.title,
    userId: "user1",
    googleDocId: overrides.googleDocId ?? `gdoc-${overrides.title}`,
    title: overrides.title,
    driveUrl: overrides.driveUrl ?? `https://docs.google.com/document/d/${overrides.title}/edit`,
    mimeType: overrides.mimeType ?? "application/vnd.google-apps.document",
    role: overrides.role ?? "REVIEWER",
    status: overrides.status ?? "INBOX",
    accessState: overrides.accessState ?? "OK",
    lastModifiedInDrive: "lastModifiedInDrive" in overrides ? overrides.lastModifiedInDrive! : new Date("2024-06-01"),
    createdTimeInDrive: overrides.createdTimeInDrive ?? null,
    owner: overrides.owner ?? null,
    labels: overrides.labels ?? [],
    _count: overrides._count ?? { unreadComments: 0, inboxComments: 0, openComments: 0 },
  } as DocWithLabels;
}

const defaultOpts: FilterOptions = {
  isInbox: "include",
  hasComments: "off",
  isAuthor: "off",
  isStarred: "off",
  mimeTypes: {},
  labels: {},
  titleFilter: "",
};

describe("filterDocs", () => {
  it("hides archived docs by default (isInbox: include)", () => {
    const docs = [
      makeDoc({ title: "Active", status: "INBOX" }),
      makeDoc({ title: "Archived", status: "ARCHIVED" }),
    ];
    const result = filterDocs(docs, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Active");
  });

  it("shows all docs when isInbox is off", () => {
    const docs = [
      makeDoc({ title: "Active", status: "INBOX" }),
      makeDoc({ title: "Archived", status: "ARCHIVED" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, isInbox: "off" });
    expect(result).toHaveLength(2);
  });

  it("shows only archived docs when isInbox is exclude", () => {
    const docs = [
      makeDoc({ title: "Active", status: "INBOX" }),
      makeDoc({ title: "Archived", status: "ARCHIVED" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, isInbox: "exclude" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Archived");
  });

  it("filters by hasComments include (only with comments)", () => {
    const docs = [
      makeDoc({ title: "NoComments", _count: { unreadComments: 0, inboxComments: 0, openComments: 0 } }),
      makeDoc({ title: "HasComments", _count: { unreadComments: 0, inboxComments: 1, openComments: 3 } }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, hasComments: "include" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("HasComments");
  });

  it("filters by hasComments exclude (only without comments)", () => {
    const docs = [
      makeDoc({ title: "NoComments", _count: { unreadComments: 0, inboxComments: 0, openComments: 0 } }),
      makeDoc({ title: "HasComments", _count: { unreadComments: 0, inboxComments: 1, openComments: 3 } }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, hasComments: "exclude" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("NoComments");
  });

  it("filters by isAuthor include (AUTHOR only)", () => {
    const docs = [
      makeDoc({ title: "Author", role: "AUTHOR" }),
      makeDoc({ title: "Reviewer", role: "REVIEWER" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, isAuthor: "include" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Author");
  });

  it("filters by isAuthor exclude (non-AUTHOR only)", () => {
    const docs = [
      makeDoc({ title: "Author", role: "AUTHOR" }),
      makeDoc({ title: "Reviewer", role: "REVIEWER" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, isAuthor: "exclude" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Reviewer");
  });

  it("filters by MIME type include", () => {
    const docs = [
      makeDoc({ title: "Doc", mimeType: "application/vnd.google-apps.document" }),
      makeDoc({ title: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }),
      makeDoc({ title: "Slide", mimeType: "application/vnd.google-apps.presentation" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      mimeTypes: { "application/vnd.google-apps.spreadsheet": "include" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Sheet");
  });

  it("filters by MIME type exclude", () => {
    const docs = [
      makeDoc({ title: "Doc", mimeType: "application/vnd.google-apps.document" }),
      makeDoc({ title: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }),
      makeDoc({ title: "Slide", mimeType: "application/vnd.google-apps.presentation" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      mimeTypes: { "application/vnd.google-apps.spreadsheet": "exclude" },
    });
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.title)).toEqual(["Doc", "Slide"]);
  });

  it("filters by MIME type include and exclude simultaneously", () => {
    const docs = [
      makeDoc({ title: "Doc", mimeType: "application/vnd.google-apps.document" }),
      makeDoc({ title: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }),
      makeDoc({ title: "Slide", mimeType: "application/vnd.google-apps.presentation" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      mimeTypes: {
        "application/vnd.google-apps.document": "include",
        "application/vnd.google-apps.presentation": "include",
        "application/vnd.google-apps.spreadsheet": "exclude",
      },
    });
    // include filters to Doc + Slide, exclude removes Sheet (already not in include set)
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.title)).toEqual(["Doc", "Slide"]);
  });

  it("filters by label include", () => {
    const docs = [
      makeDoc({
        title: "Labeled",
        labels: [{ docId: "d1", labelId: "L1", label: { labelId: "L1", userId: "u", name: "Bug", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({ title: "Unlabeled" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      labels: { L1: "include" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Labeled");
  });

  it("filters by label exclude", () => {
    const docs = [
      makeDoc({
        title: "Labeled",
        labels: [{ docId: "d1", labelId: "L1", label: { labelId: "L1", userId: "u", name: "Bug", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({ title: "Unlabeled" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      labels: { L1: "exclude" },
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Unlabeled");
  });

  it("filters by label include and exclude simultaneously", () => {
    const docs = [
      makeDoc({
        title: "HasBug",
        labels: [{ docId: "d1", labelId: "L1", label: { labelId: "L1", userId: "u", name: "Bug", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({
        title: "HasFeature",
        labels: [{ docId: "d2", labelId: "L2", label: { labelId: "L2", userId: "u", name: "Feature", color: null, position: 1 } }] as DocWithLabels["labels"],
      }),
      makeDoc({
        title: "HasBoth",
        labels: [
          { docId: "d3", labelId: "L1", label: { labelId: "L1", userId: "u", name: "Bug", color: null, position: 0 } },
          { docId: "d3", labelId: "L2", label: { labelId: "L2", userId: "u", name: "Feature", color: null, position: 1 } },
        ] as DocWithLabels["labels"],
      }),
      makeDoc({ title: "NoLabels" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      labels: { L1: "include", L2: "exclude" },
    });
    // Must have L1 (include OR) AND must not have L2 (exclude)
    // HasBug: has L1, no L2 → pass
    // HasFeature: no L1 → fail include
    // HasBoth: has L1, has L2 → fail exclude
    // NoLabels: no L1 → fail include
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("HasBug");
  });

  it("filters by multiple label include (uses AND)", () => {
    const docs = [
      makeDoc({
        title: "HasL1",
        labels: [{ docId: "d1", labelId: "L1", label: { labelId: "L1", name: "L1", userId: "u", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({
        title: "HasL2",
        labels: [{ docId: "d2", labelId: "L2", label: { labelId: "L2", name: "L2", userId: "u", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({
        title: "HasBoth",
        labels: [
          { docId: "d3", labelId: "L1", label: { labelId: "L1", name: "L1", userId: "u", color: null, position: 0 } },
          { docId: "d3", labelId: "L2", label: { labelId: "L2", name: "L2", userId: "u", color: null, position: 1 } },
        ] as DocWithLabels["labels"],
      }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      labels: { L1: "include", L2: "include" },
    });
    // DESIRED BEHAVIOR: AND logic (should only return HasBoth)
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("HasBoth");
  });

  it("filters by title regex", () => {
    const docs = [
      makeDoc({ title: "Design Doc" }),
      makeDoc({ title: "Meeting Notes" }),
      makeDoc({ title: "Design Review" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, titleFilter: "^design" });
    expect(result).toHaveLength(2);
  });

  it("falls back to substring match on invalid regex", () => {
    const docs = [
      makeDoc({ title: "Test (foo)" }),
      makeDoc({ title: "Other" }),
    ];
    // Unbalanced paren is invalid regex
    const result = filterDocs(docs, { ...defaultOpts, titleFilter: "(foo" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Test (foo)");
  });

  it("title filter is case-insensitive", () => {
    const docs = [
      makeDoc({ title: "UPPERCASE" }),
      makeDoc({ title: "lowercase" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, titleFilter: "upper" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("UPPERCASE");
  });

  it("returns all active docs with default filters", () => {
    const docs = [
      makeDoc({ title: "A" }),
      makeDoc({ title: "B" }),
      makeDoc({ title: "C" }),
    ];
    expect(filterDocs(docs, defaultOpts)).toHaveLength(3);
  });
});

describe("sortDocs", () => {
  it("sorts by title ascending", () => {
    const docs = [
      makeDoc({ title: "Charlie" }),
      makeDoc({ title: "Alpha" }),
      makeDoc({ title: "Bravo" }),
    ];
    const result = sortDocs(docs, "title", "asc");
    expect(result.map((d) => d.title)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("sorts by title descending", () => {
    const docs = [
      makeDoc({ title: "Alpha" }),
      makeDoc({ title: "Charlie" }),
      makeDoc({ title: "Bravo" }),
    ];
    const result = sortDocs(docs, "title", "desc");
    expect(result.map((d) => d.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  it("sorts by inbox comments ascending", () => {
    const docs = [
      makeDoc({ title: "Many", _count: { unreadComments: 0, inboxComments: 5, openComments: 10 } }),
      makeDoc({ title: "Few", _count: { unreadComments: 0, inboxComments: 1, openComments: 3 } }),
      makeDoc({ title: "None", _count: { unreadComments: 0, inboxComments: 0, openComments: 2 } }),
    ];
    const result = sortDocs(docs, "inbox", "asc");
    expect(result.map((d) => d.title)).toEqual(["None", "Few", "Many"]);
  });

  it("sorts by inbox comments descending", () => {
    const docs = [
      makeDoc({ title: "None", _count: { unreadComments: 0, inboxComments: 0, openComments: 2 } }),
      makeDoc({ title: "Many", _count: { unreadComments: 0, inboxComments: 5, openComments: 10 } }),
      makeDoc({ title: "Few", _count: { unreadComments: 0, inboxComments: 1, openComments: 3 } }),
    ];
    const result = sortDocs(docs, "inbox", "desc");
    expect(result.map((d) => d.title)).toEqual(["Many", "Few", "None"]);
  });

  it("sorts by open comments ascending", () => {
    const docs = [
      makeDoc({ title: "Many", _count: { unreadComments: 0, inboxComments: 5, openComments: 10 } }),
      makeDoc({ title: "Few", _count: { unreadComments: 0, inboxComments: 0, openComments: 1 } }),
      makeDoc({ title: "None", _count: { unreadComments: 0, inboxComments: 0, openComments: 0 } }),
    ];
    const result = sortDocs(docs, "open", "asc");
    expect(result.map((d) => d.title)).toEqual(["None", "Few", "Many"]);
  });

  it("sorts by open comments descending", () => {
    const docs = [
      makeDoc({ title: "None", _count: { unreadComments: 0, inboxComments: 0, openComments: 0 } }),
      makeDoc({ title: "Many", _count: { unreadComments: 0, inboxComments: 5, openComments: 10 } }),
      makeDoc({ title: "Few", _count: { unreadComments: 0, inboxComments: 0, openComments: 1 } }),
    ];
    const result = sortDocs(docs, "open", "desc");
    expect(result.map((d) => d.title)).toEqual(["Many", "Few", "None"]);
  });

  it("sorts by lastModifiedInDrive ascending", () => {
    const docs = [
      makeDoc({ title: "New", lastModifiedInDrive: new Date("2024-06-15") }),
      makeDoc({ title: "Old", lastModifiedInDrive: new Date("2024-01-01") }),
      makeDoc({ title: "Mid", lastModifiedInDrive: new Date("2024-03-10") }),
    ];
    const result = sortDocs(docs, "lastModifiedInDrive", "asc");
    expect(result.map((d) => d.title)).toEqual(["Old", "Mid", "New"]);
  });

  it("sorts by lastModifiedInDrive descending", () => {
    const docs = [
      makeDoc({ title: "Old", lastModifiedInDrive: new Date("2024-01-01") }),
      makeDoc({ title: "New", lastModifiedInDrive: new Date("2024-06-15") }),
    ];
    const result = sortDocs(docs, "lastModifiedInDrive", "desc");
    expect(result.map((d) => d.title)).toEqual(["New", "Old"]);
  });

  it("treats null lastModifiedInDrive as epoch 0", () => {
    const docs = [
      makeDoc({ title: "HasDate", lastModifiedInDrive: new Date("2024-01-01") }),
      makeDoc({ title: "NoDate", lastModifiedInDrive: null }),
    ];
    const result = sortDocs(docs, "lastModifiedInDrive", "asc");
    expect(result.map((d) => d.title)).toEqual(["NoDate", "HasDate"]);
  });

  it("does not mutate the input array", () => {
    const docs = [
      makeDoc({ title: "B" }),
      makeDoc({ title: "A" }),
    ];
    const original = [...docs];
    sortDocs(docs, "title", "asc");
    expect(docs.map((d) => d.title)).toEqual(original.map((d) => d.title));
  });
});

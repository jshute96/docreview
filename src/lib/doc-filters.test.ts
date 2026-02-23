import { describe, it, expect } from "vitest";
import { filterDocs, sortDocs } from "./doc-filters";
import type { FilterOptions } from "./doc-filters";
import type { DocWithLabels } from "@/types";

// Helper to build a minimal DocWithLabels for testing
function makeDoc(overrides: Partial<DocWithLabels> & { title: string }): DocWithLabels {
  return {
    id: overrides.id ?? overrides.title,
    userId: "user1",
    googleDocId: overrides.googleDocId ?? `gdoc-${overrides.title}`,
    title: overrides.title,
    driveUrl: overrides.driveUrl ?? `https://docs.google.com/document/d/${overrides.title}/edit`,
    mimeType: overrides.mimeType ?? "application/vnd.google-apps.document",
    role: overrides.role ?? "REVIEWER",
    status: overrides.status ?? "ACTIVE",
    isDeleted: overrides.isDeleted ?? false,
    lastModifiedInDrive: "lastModifiedInDrive" in overrides ? overrides.lastModifiedInDrive! : new Date("2024-06-01"),
    createdTimeInDrive: overrides.createdTimeInDrive ?? null,
    owner: overrides.owner ?? null,
    labels: overrides.labels ?? [],
    _count: overrides._count ?? { comments: 0 },
  } as DocWithLabels;
}

const defaultOpts: FilterOptions = {
  showArchived: false,
  hasCommentsFilter: false,
  roleFilter: null,
  selectedMimeTypes: [],
  selectedLabelIds: [],
  titleFilter: "",
};

describe("filterDocs", () => {
  it("hides archived docs by default", () => {
    const docs = [
      makeDoc({ title: "Active", status: "ACTIVE" }),
      makeDoc({ title: "Archived", status: "ARCHIVED" }),
    ];
    const result = filterDocs(docs, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Active");
  });

  it("shows archived docs when showArchived is true", () => {
    const docs = [
      makeDoc({ title: "Active", status: "ACTIVE" }),
      makeDoc({ title: "Archived", status: "ARCHIVED" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, showArchived: true });
    expect(result).toHaveLength(2);
  });

  it("filters by hasComments", () => {
    const docs = [
      makeDoc({ title: "NoComments", _count: { comments: 0 } }),
      makeDoc({ title: "HasComments", _count: { comments: 3 } }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, hasCommentsFilter: true });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("HasComments");
  });

  it("filters by role AUTHOR", () => {
    const docs = [
      makeDoc({ title: "Author", role: "AUTHOR" }),
      makeDoc({ title: "Reviewer", role: "REVIEWER" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, roleFilter: "AUTHOR" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Author");
  });

  it("filters by role NOT_AUTHOR", () => {
    const docs = [
      makeDoc({ title: "Author", role: "AUTHOR" }),
      makeDoc({ title: "Reviewer", role: "REVIEWER" }),
    ];
    const result = filterDocs(docs, { ...defaultOpts, roleFilter: "NOT_AUTHOR" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Reviewer");
  });

  it("filters by MIME type", () => {
    const docs = [
      makeDoc({ title: "Doc", mimeType: "application/vnd.google-apps.document" }),
      makeDoc({ title: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }),
      makeDoc({ title: "Slide", mimeType: "application/vnd.google-apps.presentation" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      selectedMimeTypes: ["application/vnd.google-apps.spreadsheet"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Sheet");
  });

  it("filters by label IDs", () => {
    const docs = [
      makeDoc({
        title: "Labeled",
        labels: [{ docId: "d1", labelId: "L1", label: { id: "L1", userId: "u", name: "Bug", color: null, position: 0 } }] as DocWithLabels["labels"],
      }),
      makeDoc({ title: "Unlabeled" }),
    ];
    const result = filterDocs(docs, {
      ...defaultOpts,
      selectedLabelIds: ["L1"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Labeled");
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

  it("sorts by comments ascending", () => {
    const docs = [
      makeDoc({ title: "Many", _count: { comments: 10 } }),
      makeDoc({ title: "Few", _count: { comments: 1 } }),
      makeDoc({ title: "None", _count: { comments: 0 } }),
    ];
    const result = sortDocs(docs, "comments", "asc");
    expect(result.map((d) => d.title)).toEqual(["None", "Few", "Many"]);
  });

  it("sorts by comments descending", () => {
    const docs = [
      makeDoc({ title: "None", _count: { comments: 0 } }),
      makeDoc({ title: "Many", _count: { comments: 10 } }),
      makeDoc({ title: "Few", _count: { comments: 1 } }),
    ];
    const result = sortDocs(docs, "comments", "desc");
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

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Test the encode/decode/recursive-walk logic by importing internals
// via a wrapper. The extension itself is tested indirectly through the
// Prisma mock in integration, but the pure functions deserve unit tests.

// Re-implement the same encode/decode used by the module (base64)
function encode(val: string): string {
  return Buffer.from(val, "utf8").toString("base64");
}

function decode(val: string): string {
  return Buffer.from(val, "base64").toString("utf8");
}

describe("base64 encode/decode", () => {
  it("round-trips plain ASCII", () => {
    expect(decode(encode("hello world"))).toBe("hello world");
  });

  it("round-trips Unicode", () => {
    const text = "café résumé 日本語";
    expect(decode(encode(text))).toBe(text);
  });

  it("round-trips empty string", () => {
    expect(decode(encode(""))).toBe("");
  });

  it("round-trips multiline text", () => {
    const text = "line 1\nline 2\nline 3";
    expect(decode(encode(text))).toBe(text);
  });
});

// Test the recursive decode logic by reimplementing the same algorithm
// (since the module doesn't export it) and verifying the shape handling.
const ALL_OBSCURED = new Set(["title", "notes", "owner", "name"]);

function decodeResult(result: unknown): void {
  if (result == null || typeof result !== "object") return;
  if (Array.isArray(result)) {
    for (const item of result) decodeResult(item);
    return;
  }
  const obj = result as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (ALL_OBSCURED.has(key) && typeof val === "string") {
      obj[key] = decode(val);
    } else if (val && typeof val === "object") {
      decodeResult(val);
    }
  }
}

describe("decodeResult", () => {
  it("decodes top-level obscured fields", () => {
    const doc = { title: encode("My Doc"), notes: encode("some notes"), status: "INBOX" };
    decodeResult(doc);
    expect(doc.title).toBe("My Doc");
    expect(doc.notes).toBe("some notes");
    expect(doc.status).toBe("INBOX");
  });

  it("decodes nested label name through DocLabel junction", () => {
    const doc = {
      title: encode("Doc"),
      labels: [
        { labelId: "l1", label: { name: encode("urgent") } },
        { labelId: "l2", label: { name: encode("review") } },
      ],
    };
    decodeResult(doc);
    expect(doc.title).toBe("Doc");
    expect(doc.labels[0].label.name).toBe("urgent");
    expect(doc.labels[1].label.name).toBe("review");
  });

  it("handles null and undefined obscured fields", () => {
    const doc = { title: encode("T"), notes: null, owner: undefined };
    decodeResult(doc);
    expect(doc.title).toBe("T");
    expect(doc.notes).toBeNull();
    expect(doc.owner).toBeUndefined();
  });

  it("handles arrays of results", () => {
    const docs = [
      { title: encode("A"), owner: encode("Alice") },
      { title: encode("B"), owner: encode("Bob") },
    ];
    decodeResult(docs);
    expect(docs[0].title).toBe("A");
    expect(docs[1].owner).toBe("Bob");
  });

  it("handles null/undefined input without throwing", () => {
    expect(() => decodeResult(null)).not.toThrow();
    expect(() => decodeResult(undefined)).not.toThrow();
  });

  it("does not touch non-obscured string fields", () => {
    const doc = { title: encode("T"), googleDocId: "abc123", mimeType: "text/plain" };
    decodeResult(doc);
    expect(doc.googleDocId).toBe("abc123");
    expect(doc.mimeType).toBe("text/plain");
  });

  it("handles _count objects without errors", () => {
    const doc = {
      title: encode("T"),
      _count: { inboxComments: 3, openComments: 5 },
    };
    decodeResult(doc);
    expect(doc.title).toBe("T");
    expect(doc._count.inboxComments).toBe(3);
  });
});

describe("obscured field name uniqueness", () => {
  // The recursive decoder matches fields by column name alone, not by
  // table+column. If a new model introduces a column with the same name
  // as an obscured field, it would be incorrectly decoded. This test
  // parses the Prisma schema to catch that before it causes a bug.

  // Tables where we know the column exists but is NOT obscured.
  const KNOWN_EXCEPTIONS: Record<string, string[]> = {
    name: ["users"],
  };

  // Obscured table→fields, matching OBSCURED_FIELDS in prisma-obscure.ts.
  const OBSCURED: Record<string, string[]> = {
    docs: ["title", "notes", "owner"],
    labels: ["name"],
  };

  // Parse schema.prisma to find which @@map table name owns each field.
  function parseSchemaFields(): Map<string, string[]> {
    const schema = readFileSync(
      join(__dirname, "../../prisma/schema.prisma"),
      "utf8",
    );
    const fieldToTables = new Map<string, string[]>();
    let currentTable: string | null = null;

    for (const line of schema.split("\n")) {
      // Match @@map("table_name") to get the SQL table name
      const mapMatch = line.match(/@@map\("(\w+)"\)/);
      if (mapMatch) {
        currentTable = null; // end of model
        continue;
      }
      // Match model declaration
      const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
      if (modelMatch) {
        // Table name will be set by @@map; track model name for now
        currentTable = modelMatch[1];
        continue;
      }
      if (line.trim() === "}") {
        currentTable = null;
        continue;
      }
      if (!currentTable) continue;

      // Match field lines: "  fieldName  Type  ..."
      const fieldMatch = line.match(/^\s+(\w+)\s+\w+/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1];

      // Get the SQL column name (from @map or the field name itself)
      const colMapMatch = line.match(/@map\("(\w+)"\)/);
      const colName = colMapMatch ? colMapMatch[1] : fieldName;

      // Get the SQL table name (from @@map or lowercase model name)
      // We need to look ahead for @@map, so store model name for now
      // and resolve table names in a second pass.
      const tables = fieldToTables.get(colName) || [];
      tables.push(currentTable);
      fieldToTables.set(colName, tables);
    }

    // Second pass: resolve model names to table names via @@map
    const modelToTable = new Map<string, string>();
    const lines = schema.split("\n");
    let model: string | null = null;
    for (const line of lines) {
      const m = line.match(/^model\s+(\w+)\s*\{/);
      if (m) model = m[1];
      const t = line.match(/@@map\("(\w+)"\)/);
      if (t && model) {
        modelToTable.set(model, t[1]);
        model = null;
      }
    }

    // Remap model names to table names
    const resolved = new Map<string, string[]>();
    for (const [col, models] of fieldToTables) {
      resolved.set(
        col,
        models.map((m) => modelToTable.get(m) || m.toLowerCase()),
      );
    }
    return resolved;
  }

  it("obscured field names do not collide with non-obscured tables", () => {
    const fieldToTables = parseSchemaFields();
    const allObscuredFields = new Set(Object.values(OBSCURED).flat());
    const errors: string[] = [];

    for (const fieldName of allObscuredFields) {
      const tables = fieldToTables.get(fieldName) || [];
      const obscuredTable = Object.entries(OBSCURED).find(([, fields]) =>
        fields.includes(fieldName),
      )?.[0];
      const exceptions = KNOWN_EXCEPTIONS[fieldName] || [];

      for (const table of tables) {
        if (table === obscuredTable) continue; // this is the obscured table itself
        if (exceptions.includes(table)) continue; // known exception
        errors.push(
          `Column "${fieldName}" exists on table "${table}" which is not obscured ` +
            `and not in KNOWN_EXCEPTIONS. The recursive decoder would incorrectly ` +
            `decode this field. Either add "${table}" to KNOWN_EXCEPTIONS (if it ` +
            `will never appear in nested includes) or make the decoder model-aware.`,
        );
      }
    }

    expect(errors).toEqual([]);
  });
});

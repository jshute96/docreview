/**
 * Prisma client extension that base64-encodes specified string fields on write
 * and decodes them on read. The database stores obscured values; Prisma code
 * sees plaintext transparently.
 *
 * Matching UDFs (encode_base64 / decode_base64) live in the database for
 * manual querying — see the migration that created them.
 */
import { Prisma } from "@prisma/client";

/**
 * model name (lowercase) → fields to obscure.
 *
 * IMPORTANT: "name" is used by Label but also exists on User. The recursive
 * decoder uses ALL_OBSCURED (a flat set of all field names) and cannot
 * distinguish models, so querying User via the Prisma client will incorrectly
 * decode User.name. Use $queryRaw for User queries that include name, or fix
 * decodeResult to be model-aware. See TODO in comments/[docId]/page.tsx.
 */
const OBSCURED_FIELDS: Record<string, string[]> = {
  doc: ["title", "notes"],
  label: ["name"],
};

function encode(val: string): string {
  return Buffer.from(val, "utf8").toString("base64");
}

function decode(val: string): string {
  return Buffer.from(val, "base64").toString("utf8");
}

/** Encode obscured fields inside a data object (create / update payload). */
function encodeData(fields: string[], data: Record<string, unknown>): void {
  for (const f of fields) {
    if (typeof data[f] === "string") {
      data[f] = encode(data[f] as string);
    }
  }
}

/** All obscured field names across all models. */
const ALL_OBSCURED = new Set(Object.values(OBSCURED_FIELDS).flat());

/**
 * Recursively decode obscured fields throughout an entire result tree.
 * Handles nested includes (e.g., doc.labels[i].label.name) by walking
 * all objects and arrays and decoding any string field whose name is in
 * the obscured set.
 */
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

const WRITE_OPS = new Set([
  "create",
  "update",
  "upsert",
  "createMany",
  "createManyAndReturn",
  "updateMany",
]);

export const obscureExtension = Prisma.defineExtension({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // Encode on write (only for models with obscured fields)
        const fields = OBSCURED_FIELDS[model!.toLowerCase()];
        if (fields && WRITE_OPS.has(operation)) {
          const a = args as Record<string, unknown>;
          if (a.data) {
            if (Array.isArray(a.data)) {
              // createMany with array of rows
              for (const row of a.data) encodeData(fields, row);
            } else if (typeof a.data === "object") {
              encodeData(fields, a.data as Record<string, unknown>);
            }
          }
          // upsert has separate create / update payloads
          if (a.create && typeof a.create === "object") {
            encodeData(fields, a.create as Record<string, unknown>);
          }
          if (a.update && typeof a.update === "object") {
            encodeData(fields, a.update as Record<string, unknown>);
          }
        }

        const result = await query(args);

        // Decode on read — recursive walk handles nested includes
        // (e.g., Doc includes Label via DocLabel)
        decodeResult(result);

        return result;
      },
    },
  },
});

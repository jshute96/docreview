import { createHash } from "crypto";
import { SuggestionType } from "@prisma/client";

// Computes a content hash for a suggestion to enable matching across data sources
// (Docs API and Gmail notifications). The hash is based on the action type and text
// content, which are available from both sources.
//
// Gmail uses "Add"/"Delete"/"Replace"; Docs API uses "INSERT"/"DELETE"/"EDIT".
// Callers must normalize to the canonical form before calling.
export function computeSuggestionHash(
  actionType: SuggestionType,
  deletedText: string,
  insertedText: string,
): string {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const input = `${actionType}|${normalize(deletedText)}|${normalize(insertedText)}`;
  return createHash("sha256").update(input).digest("hex");
}

// Maps Gmail notification action strings to canonical suggestion types.
export function gmailActionToSuggestionType(
  action: string,
): SuggestionType {
  switch (action) {
    case "Add": return SuggestionType.INSERT;
    case "Delete": return SuggestionType.DELETE;
    case "Replace": return SuggestionType.EDIT;
    default: return SuggestionType.OTHER;
  }
}

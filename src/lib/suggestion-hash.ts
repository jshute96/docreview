import { createHash } from "crypto";
import { SuggestionType } from "@prisma/client";
import type { Suggestion } from "@/lib/parse-gmail-notification";

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

// Split a Gmail-parsed suggestion's text fields into (deletedText, insertedText)
// for content hashing. Add → inserted only; Delete → deleted only; Replace → both
// from oldText/newText; everything else → empty (non-text suggestions hash the
// action label alone, matching Drive sync and extension sync).
export function extractHashTextsFromGmail(
  s: Pick<Suggestion, "action" | "text" | "oldText" | "newText">,
): { deletedText: string; insertedText: string } {
  switch (s.action) {
    case "Add":
      return { deletedText: "", insertedText: s.text };
    case "Delete":
      return { deletedText: s.text, insertedText: "" };
    case "Replace":
      return { deletedText: s.oldText ?? "", insertedText: s.newText ?? "" };
    default:
      return { deletedText: "", insertedText: "" };
  }
}

// Split an extension-scraped suggestion's text fields the same way, using the
// already-separated oldText/newText fields the extension provides. The Gmail
// action labels ("Add"/"Delete"/"Replace") are reused — the extension sends
// the same strings in its `suggestionType` field.
export function extractHashTextsFromExtension(
  action: string,
  oldText: string,
  newText: string,
): { deletedText: string; insertedText: string } {
  const deletedText = action === "Delete" || action === "Replace" ? oldText : "";
  const insertedText = action === "Add" || action === "Replace" ? newText : "";
  return { deletedText, insertedText };
}

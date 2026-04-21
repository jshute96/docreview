import { createHash } from "crypto";
import { SuggestionType } from "@prisma/client";
import type { Suggestion } from "@/lib/parse-gmail-notification";

// Computes a content hash for a suggestion to enable matching across data sources
// (Docs API, Gmail notifications, and the Chrome extension scraping the Docs UI).
// The hash is based on the action type and text content, which all three sources
// expose.
//
// Gmail uses "Add"/"Delete"/"Replace"; Docs API uses "INSERT"/"DELETE"/"EDIT".
// Callers must normalize to the canonical form before calling.
//
// Observed source behaviors (which dictate the normalizer rules below):
//   - Docs API (`documents.get` suggestion fragments) and Drive's `comments.get`
//     return the full comment/suggestion text verbatim, preserving every
//     whitespace character (including newlines between paragraphs).
//   - Gmail notifications display text that has already been whitespace-trimmed
//     and run-collapsed to single spaces, then truncated to ~100 characters
//     with a single-character "…" glyph appended to indicate truncation.
//   - The Docs UI (what the extension scrapes) presents the same trimmed +
//     collapsed + 100-char + "…" treatment as Gmail.
// To make a Docs-API hash match an already-truncated Gmail/extension hash, we
// apply the strictest of the three (truncate-to-100-with-trim) to every input.
export function computeSuggestionHash(
  actionType: SuggestionType,
  deletedText: string,
  insertedText: string,
): string {
  const normalize = (s: string) => {
    // 1. Remove trailing ellipsis (both ... and …)
    const withoutEllipsis = s.replace(/\.\.\.$/, "").replace(/…$/, "");
    // 2. Trim and
    // 3. Collapse whitespace
    return withoutEllipsis.trim().replace(/\s+/g, " ");
  };

  const normD = normalize(deletedText);
  const normI = normalize(insertedText);
  // 4. Truncate to 100 characters and 
  // 5. Trim again to remove boundary spaces
  const truncD = normD.substring(0, 100).trim();
  const truncI = normI.substring(0, 100).trim();

  const input = `${actionType}|${truncD}|${truncI}`;
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

/**
 * Google's own labels for what a suggestion does. The same four strings appear
 * in Gmail notification emails and in the extension's DOM scrape
 * (`suggestionType`), so both sources branch on this one vocabulary.
 *
 * Not a closed set at the source: anything that isn't a text change ("Format",
 * "Add link", …) is normalized to `Other`, and a suggestion whose details
 * weren't visible carries its own label, so parsed values stay `string`.
 */
export const SuggestionLabel = {
  Add: "Add",
  Delete: "Delete",
  Replace: "Replace",
  Other: "Other",
} as const;

export type SuggestionLabel = (typeof SuggestionLabel)[keyof typeof SuggestionLabel];

// Validation for Google Docs "disco" IDs — the discussion identifier that keys
// a comment or suggestion thread.
//
// The same ID appears in three places, which is what makes it the join key
// across the whole app:
//   - scraped from the Docs DOM by the Chrome extension (`getDiscoId`)
//   - parsed out of `disco=` in Gmail notification links (`extractDiscoId`)
//   - stored in `Comment.googleCommentId`
//
// Because every downstream lookup (DB match, hash merge, DOM navigation) keys
// on exact equality, a malformed or placeholder value is worse than a missing
// one: it can never match anything, but it does occupy the column and make the
// row ineligible for the merge paths that would otherwise repair it. Sources
// that can't produce a real ID must yield null — never a sentinel string.

/**
 * Google disco IDs look like `AAAB1agdt2A` — the literal prefix `AAA`, an
 * uppercase letter, then base64url-ish characters. Deliberately loose on
 * length (matching `extractIdByPath` in the extension rather than the stricter
 * discovery heuristic): this is a guard against sentinels, empty strings, and
 * obviously-wrong values, not an attempt to predict Google's ID length.
 *
 * Keep in sync with the patterns in `background-injected.js`. This one is
 * stricter than the extension's `extractIdByPath` check (it's anchored at both
 * ends), so a value can pass the scrape and still be rejected here — callers
 * must treat a rejection as a partial result, not as "nothing was missing".
 */
const DISCO_ID_PATTERN = /^AAA[A-Z][A-Za-z0-9_-]+$/;

/** True if `id` is a syntactically valid Google Docs disco ID. */
export function isDiscoId(id: unknown): id is string {
  return typeof id === "string" && DISCO_ID_PATTERN.test(id);
}

import type { CommentThread } from "@/lib/google-drive";

/**
 * Message shown when the browser extension reports that the text a thread
 * was anchored to has been deleted from the document (so Google Docs no
 * longer shows the thread in the margin). Returns undefined when the thread
 * is not known to be orphaned.
 *
 * Shared by the expanded thread panel (inline warning) and the collapsed
 * summary row (the "Deleted" badge tooltip) so the wording matches.
 */
export function deletedContentWarning(
  thread: Pick<CommentThread, "originalContentDeleted" | "quotedFileContent"> | undefined,
  isSuggestion: boolean,
  resolved: boolean,
): string | undefined {
  // A resolved suggestion has no anchor by design (it was accepted or
  // rejected), so "content deleted" isn't a warning for it.
  if (!thread?.originalContentDeleted || (isSuggestion && resolved)) return undefined;
  const typeLabel = isSuggestion ? "suggestion" : "comment";
  const noun = resolved && thread.quotedFileContent?.value ? "text" : typeLabel;
  return `Original content deleted. This ${noun} is not visible in the document.`;
}

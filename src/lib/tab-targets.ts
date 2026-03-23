/**
 * Named window targets for tab reuse.
 *
 * When opening a URL with window.open(url, name) or <a target="name">,
 * the browser reuses an existing tab with that name instead of opening
 * a new one. Middle-click bypasses the target and opens a fresh tab.
 *
 * Target names use the Google Doc ID (not the Prisma docId) so they
 * match the names the Chrome extension uses when opening Docreview
 * from Google Docs pages.
 *
 * Names are scoped per origin, so multiple Docreview instances on
 * different servers won't conflict.
 */

/** Target name for opening a doc's comments page in Docreview. */
export function commentsTarget(googleDocId: string): string {
  return `dr-${googleDocId}`;
}

/** Target name for opening a Google Doc/Sheet/Slide. */
export function docTarget(googleDocId: string): string {
  return `doc-${googleDocId}`;
}

/** Open a doc's comments page, reusing the existing tab if one is open. */
export function openCommentsPage(docId: string, googleDocId: string): void {
  window.open(`/comments/${docId}`, commentsTarget(googleDocId));
}

/** Open a Google Doc/Sheet/Slide URL, reusing the existing tab if one is open. */
export function openDocPage(googleDocId: string, driveUrl: string): void {
  window.open(driveUrl, docTarget(googleDocId));
}

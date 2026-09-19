"use client";

// Warning toast listing docs whose refresh/load failed transiently. Fired
// alongside the normal completion toast so failures aren't buried in its
// "(N errors)" suffix. Auto-dismisses (long) rather than persisting: the
// failed docs are retried automatically on the next refresh, so this is an
// announcement, not a state the user must clear.

import { toast } from "sonner";
import { pluralize } from "@/lib/utils";
import { commentsTarget, docTarget } from "@/lib/tab-targets";

export const SYNC_ERRORS_TOAST_ID = "sync-errors";
const MAX_LISTED = 5;
const DURATION_MS = 20000;

interface DocRef {
  docId: string;
  googleDocId: string;
}

/**
 * Show the sync-errors warning toast, or dismiss any earlier one when there
 * are no errors (so a clean refresh clears a stale warning).
 * `docs` maps Google Doc IDs to DB rows (for the /comments link); a failed doc
 * with no row yet (new Gmail-discovered doc whose metadata fetch failed) links
 * to Google Docs instead. `titles` is the client-side title cache; a doc whose
 * title isn't cached yet (e.g. just added) falls back to its shortened ID.
 * `source` picks the retry note: refresh failures are retried automatically,
 * Load failures are not (a doc whose metadata fetch failed never got a row).
 */
export function showSyncErrorsToast(
  errorDocIds: string[] | undefined,
  docs: DocRef[],
  titles: Record<string, string>,
  source: "refresh" | "load" = "refresh",
) {
  const ids = [...new Set(errorDocIds ?? [])];
  if (ids.length === 0) {
    toast.dismiss(SYNC_ERRORS_TOAST_ID);
    return;
  }
  const byGoogleId = new Map(docs.map(d => [d.googleDocId, d]));
  const listed = ids.slice(0, MAX_LISTED);
  const more = ids.length - listed.length;
  const note = source === "load"
    ? "Try loading them again."
    : "They\u2019ll be retried automatically on the next refresh.";

  toast.warning(`${pluralize(ids.length, "document")} couldn't be synced`, {
    id: SYNC_ERRORS_TOAST_ID,
    duration: DURATION_MS,
    closeButton: true,
    description: (
      <div className="mt-1 space-y-1">
        <div>{note}</div>
        <ul className="list-disc list-inside">
          {listed.map(gid => {
            const doc = byGoogleId.get(gid);
            const title = titles[gid] || `Document ${gid.slice(0, 8)}…`;
            const href = doc ? `/comments/${doc.docId}` : `https://docs.google.com/document/d/${gid}/edit`;
            return (
              <li key={gid} className="truncate">
                <a
                  href={href}
                  target={doc ? commentsTarget(gid) : docTarget(gid)}
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                  title={doc ? "Open this document's comments page" : "Open this document in Google Docs"}
                >
                  {title}
                </a>
              </li>
            );
          })}
          {more > 0 && <li className="list-none pl-[1.25em] text-muted-foreground">…and {more} more</li>}
        </ul>
      </div>
    ),
  });
}

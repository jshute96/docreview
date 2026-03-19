"use client";

import { useEffect, useRef } from "react";
import { bookmarkletCode } from "@/bookmarklet/bookmarklet-code";
import { openInDocreviewCode } from "@/bookmarklet/open-in-docreview-code";

export function BookmarkletClient() {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const openLinkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const origin = window.location.origin;

    const finalCode = bookmarkletCode.replace(/__BASE_URL__/g, origin);
    if (linkRef.current) {
      linkRef.current.setAttribute("href", `javascript:${finalCode}`);
    }

    const openCode = openInDocreviewCode.replace(/__BASE_URL__/g, origin);
    if (openLinkRef.current) {
      openLinkRef.current.setAttribute("href", `javascript:${openCode}`);
    }
  }, []);

  return (
    <div className="mx-auto max-w-[45rem] p-8">
      <h1 className="mb-4 text-2xl font-bold flex items-center">
        <a href="/docs" className="flex-shrink-0 flex items-center text-zinc-500 hover:text-blue-600 mr-2">
          <img src="/docreview.svg" alt="Docreview Logo" className="h-6 w-6 rounded-md shadow-sm mr-2" />
          Docreview:
        </a>
        Bookmarklets
      </h1>

      <p className="mb-4 rounded-md bg-amber-50 border border-amber-200 px-4 py-2 text-amber-800">
        The <b>bookmarklets are deprecated</b>. This functionality is now provided by the Docreview Chrome extension.
      </p>

      <p className="mb-6 text-muted-foreground">
        Drag the links below to your bookmarks bar to quickly access
        Docreview from Google Docs, Sheets, Slides, Drive and Gmail.
      </p>

      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/50 p-6">
          <h2 className="mb-1 text-lg font-semibold">Add Docreview links</h2>
          <div className="mb-4 text-sm text-muted-foreground">
            Adds a Docreview icon or link:
            <ul className="my-1 ml-5 list-disc">
              <li>Next to each document in Google Drive.</li>
              <li>Next to the title in Docs, Sheets and Slides.</li>
              <li>Next to document attachments in Gmail, with an &ldquo;Open in Docreview&rdquo; link in notification emails.</li>
            </ul>
            Click the icon to open that doc in Docreview, adding it if necessary.
          </div>
          <div className="flex items-center gap-4">
            <a
              ref={linkRef}
              title="Add Docreview links"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
              onClick={(e) => e.preventDefault()}
            >
              <img src="/docreview.svg" alt="" className="h-4 w-4 rounded-[2px]" />
              Add Docreview links
            </a>
            <span className="text-sm text-muted-foreground">
              ← Drag this to your bookmarks bar
            </span>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/50 p-6">
          <h2 className="mb-1 text-lg font-semibold">Open in Docreview</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Click while viewing a doc in Google Docs, Sheets, or Slides, or a
            document notification email in Gmail.
            <br />
            Opens the doc in Docreview, adding it if necessary.
          </p>
          <div className="flex items-center gap-4">
            <a
              ref={openLinkRef}
              title="Open in Docreview"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
              onClick={(e) => e.preventDefault()}
            >
              <img src="/docreview.svg" alt="" className="h-4 w-4 rounded-[2px]" />
              Open in Docreview
            </a>
            <span className="text-sm text-muted-foreground">
              ← Drag this to your bookmarks bar
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

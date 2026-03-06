"use client";

import { useEffect, useRef } from "react";
import { bookmarkletCode } from "@/bookmarklet/bookmarklet-code";

export function BookmarkletClient() {
  const minified = `javascript:${bookmarkletCode}`;
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (linkRef.current) {
      linkRef.current.setAttribute("href", minified);
    }
  }, [minified]);

  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="mb-4 text-2xl font-bold">Docreview Bookmarklet</h1>

      <p className="mb-6 text-muted-foreground">
        Drag the link below to your bookmarks bar. When you&apos;re on a Google
        Doc, click it to add a Docreview icon next to the document title.
      </p>

      <div className="mb-8 flex items-center gap-4 rounded-lg border bg-muted/50 p-6">
        <a
          ref={linkRef}
          title="Docreview links"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
          onClick={(e) => e.preventDefault()}
        >
          <img src="/docreview.svg" alt="" className="h-4 w-4 rounded-[2px]" />
          Docreview links
        </a>
        <span className="text-sm text-muted-foreground">
          ← Drag this to your bookmarks bar
        </span>
      </div>

      <h2 className="mb-2 text-lg font-semibold">How it works</h2>
      <ol className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
        <li>Open any Google Doc, Sheet, or Slides</li>
        <li>Click the bookmarklet in your bookmarks bar</li>
        <li>
          A document icon appears next to the title — click it to open in
          Docreview
        </li>
        <li>
          If the doc is already tracked, it goes to the comments view;
          otherwise, to the add page
        </li>
      </ol>
    </div>
  );
}

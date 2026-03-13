import type { Metadata } from "next";
import { BookmarkletClient } from "./bookmarklet-client";

export const metadata: Metadata = {
  title: "Docreview: Bookmarklets",
};

export default function BookmarkletPage() {
  return <BookmarkletClient />;
}

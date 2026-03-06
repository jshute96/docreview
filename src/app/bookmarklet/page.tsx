import type { Metadata } from "next";
import { BookmarkletClient } from "./bookmarklet-client";

export const metadata: Metadata = {
  title: "Bookmarklet - Docreview",
};

export default function BookmarkletPage() {
  return <BookmarkletClient />;
}

import { headers } from "next/headers";

/**
 * Inline script that hides the page body until `useCachedMetadata` has filled in
 * document titles from localStorage, preventing a flash of untitled docs. The
 * hook removes the style once titles are in place; a 2s timeout is a fallback in
 * case the hook never runs (e.g. a JS error).
 *
 * Emitted only for an initial document request. A client-side navigation or
 * prefetch fetches this page as an RSC payload and React mounts the tree in the
 * browser, where an inline <script> is never executed (React 19 logs
 * "Encountered a script tag while rendering React component"). Hiding is also
 * pointless there: the hook's useLayoutEffect runs before the browser paints.
 *
 * The request is identified by `Sec-Fetch-Dest`, which the browser sets to
 * "document" for a top-level navigation (and "iframe"/"frame" for a nested one)
 * but "empty" for a fetch(). Next.js strips its own `RSC` header before
 * `headers()` sees it, so that can't be used. This is a heuristic, and both ways
 * of being wrong are mild: a client that sends no `Sec-Fetch-Dest` at all (an
 * old browser, or a proxy that strips it) gets the script, as before — correct
 * for a page load, and only the React 19 console error on a soft navigation.
 */
const DOCUMENT_DESTINATIONS = ["document", "iframe", "frame"];

export async function HideUntilTitles() {
  const dest = (await headers()).get("sec-fetch-dest");
  if (dest && !DOCUMENT_DESTINATIONS.includes(dest)) return null;
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){var s=document.createElement('style');s.id='hide-until-titles';s.innerHTML='body{visibility:hidden}';document.head.appendChild(s);setTimeout(function(){if(s.parentNode)s.remove()},2000);})()`,
      }}
    />
  );
}

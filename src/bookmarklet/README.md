# Docreview Bookmarklet

A bookmarklet that injects a Docreview icon into the Google Docs/Sheets/Slides titlebar. Clicking the icon opens the document in Docreview.

## How it works

When activated on a Google Docs page, the bookmarklet:

1. Extracts the document ID from the URL (the `/d/{ID}` segment)
2. Inserts a document icon into `.docs-titlebar-badges` (the badge row next to the title)
3. The icon links to `http://localhost:3000/open?doc=<url>`, which:
   - Redirects to `/comments/<docId>` if the doc is already tracked
   - Redirects to `/add?doc=<url>` if it's new

The icon uses the official Docreview logo (`docreview.svg`) hosted on the server. It's idempotent — clicking the bookmarklet twice won't duplicate the icon.

## Install via the app

1. Start Docreview: `npm run dev`
2. In the Docreview inbox view, click the **Menu** icon (three horizontal lines) in the top-right
3. Select **Bookmarklet page** (this opens `http://localhost:3000/bookmarklet`)
4. Drag the **Docreview** button to your bookmarks bar

## Distribution

The minified code for the bookmarklet is stored in `src/app/bookmarklet/bookmarklet.txt`. This can be shared or used for manual bookmark creation if needed.

## Development

The bookmarklet code is managed as a standalone source file and minified via a build script to ensure consistency across the app and distribution files.

### File Structure

- `src/bookmarklet/bookmarklet-source.js`: **Source of truth.** Edit this file to change logic or styling.
- `src/bookmarklet/bookmarklet-code.ts`: **Generated.** Minified version used by the Next.js app.
- `src/bookmarklet/bookmarklet.txt`: **Generated.** Minified `javascript:` string for distribution.
- `src/app/bookmarklet/page.tsx`: The Next.js install page UI.
- `public/docreview.svg`: The icon used by the bookmarklet.

### Build Process

**Building is not automatic.** If you edit `bookmarklet-source.js`, you must manually update the generated files by running:

```bash
npm run build:bookmarklet
```

This executes `scripts/build-bookmarklet.mjs`.

**Note:** This command is also included in the main `npm run build` script, so the bookmarklet is always up-to-date in production builds.

## Testing with the browser console

You can also paste the bookmarklet code directly into the Chrome DevTools console on a Google Docs page. Copy the code from `bookmarklet-source.js` and paste it into the console. This is useful for iterating on the DOM injection without re-saving the bookmark each time.

## Changing the host

The bookmarklet hardcodes `http://localhost:3000`. To point at a different host, update the URL in `src/bookmarklet/bookmarklet-source.js` and run `npm run build:bookmarklet`.

## Limitations

- The icon is injected at runtime and does not persist across page loads — you need to click the bookmarklet each time you open a doc
- Only works on `docs.google.com` pages with a `/d/{ID}` path
- If Google changes the `.docs-titlebar-badges` DOM structure, the injection target may need updating

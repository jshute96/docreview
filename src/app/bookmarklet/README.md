# Docreview Bookmarklet

A bookmarklet that injects a Docreview icon into the Google Docs/Sheets/Slides titlebar. Clicking the icon opens the document in Docreview.

## How it works

When activated on a Google Docs page, the bookmarklet:

1. Extracts the document ID from the URL (the `/d/{ID}` segment)
2. Inserts a document icon into `.docs-titlebar-badges` (the badge row next to the title)
3. The icon links to `http://localhost:3000/open?doc=<url>`, which:
   - Redirects to `/comments/<docId>` if the doc is already tracked
   - Redirects to `/add?doc=<url>` if it's new

The icon uses Google's own grey (`#5f6368`) and turns blue (`#1a73e8`) on hover, matching the native titlebar style. It's idempotent — clicking the bookmarklet twice won't duplicate the icon.

## Install via the app

1. Start Docreview: `npm run dev`
2. Go to `http://localhost:3000/bookmarklet`
3. Drag the **Docreview** button to your bookmarks bar

## Install manually (for testing)

If you want to install without running the app, or to test changes to the bookmarklet code:

1. Right-click your bookmarks bar and select **Add page...** (or **Add bookmark...**)
2. Set the **Name** to `Docreview`
3. Paste the following as the **URL**:

```
javascript:void((function(){if(!location.hostname.endsWith('docs.google.com'))return;var m=location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);if(!m)return;if(document.getElementById('docreview-badge'))return;var badges=document.querySelector('.docs-titlebar-badges');if(!badges)return;var url=location.href;var container=document.createElement('div');container.id='docreview-badge';container.className='docs-titlebar-badge-container goog-inline-block';var link=document.createElement('a');link.href='http://localhost:3000/open?doc='+encodeURIComponent(url);link.target='_blank';link.title='Open in Docreview';link.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;text-decoration:none;vertical-align:middle;cursor:pointer;';var svg='<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>';link.innerHTML=svg;link.onmouseenter=function(){this.querySelector('svg').setAttribute('stroke','#1a73e8')};link.onmouseleave=function(){this.querySelector('svg').setAttribute('stroke','#5f6368')};badges.insertBefore(container,badges.firstChild);container.appendChild(link)})())
```

4. Open any Google Doc and click the bookmark

## Testing with the browser console

You can also paste the bookmarklet code directly into the Chrome DevTools console on a Google Docs page. Copy the code from `bookmarkletCode` in `page.tsx` (the part inside the backticks) and paste it into the console. This is useful for iterating on the DOM injection without re-saving the bookmark each time.

## Changing the host

The bookmarklet hardcodes `http://localhost:3000`. To point at a different host, update the URL in the `bookmarkletCode` string in `page.tsx` (line 20).

## Limitations

- The icon is injected at runtime and does not persist across page loads — you need to click the bookmarklet each time you open a doc
- Only works on `docs.google.com` pages with a `/d/{ID}` path
- If Google changes the `.docs-titlebar-badges` DOM structure, the injection target may need updating

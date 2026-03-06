import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bookmarklet - Docreview",
};

const bookmarkletCode = `
(function(){
  if(!location.hostname.endsWith('docs.google.com'))return;
  var m=location.pathname.match(/\\/d\\/([a-zA-Z0-9_-]+)/);
  if(!m)return;
  if(document.getElementById('docreview-badge'))return;
  var badges=document.querySelector('.docs-titlebar-badges');
  if(!badges)return;
  var url=location.href;
  var container=document.createElement('div');
  container.id='docreview-badge';
  container.className='docs-titlebar-badge-container goog-inline-block';
  var link=document.createElement('a');
  link.href='http://localhost:3000/open?doc='+encodeURIComponent(url);
  link.target='_blank';
  link.title='Open in Docreview';
  link.style.cssText='display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;text-decoration:none;vertical-align:middle;cursor:pointer;';
  var ns='http://www.w3.org/2000/svg';
  var s=document.createElementNS(ns,'svg');
  s.setAttribute('width','18');s.setAttribute('height','18');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('fill','none');s.setAttribute('stroke','#5f6368');s.setAttribute('stroke-width','2');s.setAttribute('stroke-linecap','round');s.setAttribute('stroke-linejoin','round');
  var p=document.createElementNS(ns,'path');p.setAttribute('d','M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');s.appendChild(p);
  var pl=document.createElementNS(ns,'polyline');pl.setAttribute('points','14 2 14 8 20 8');s.appendChild(pl);
  var l1=document.createElementNS(ns,'line');l1.setAttribute('x1','16');l1.setAttribute('y1','13');l1.setAttribute('x2','8');l1.setAttribute('y2','13');s.appendChild(l1);
  var l2=document.createElementNS(ns,'line');l2.setAttribute('x1','16');l2.setAttribute('y1','17');l2.setAttribute('x2','8');l2.setAttribute('y2','17');s.appendChild(l2);
  var l3=document.createElementNS(ns,'line');l3.setAttribute('x1','10');l3.setAttribute('y1','9');l3.setAttribute('x2','8');l3.setAttribute('y2','9');s.appendChild(l3);
  link.appendChild(s);
  link.onmouseenter=function(){s.setAttribute('stroke','#1a73e8')};
  link.onmouseleave=function(){s.setAttribute('stroke','#5f6368')};
  badges.insertBefore(container,badges.firstChild);
  container.appendChild(link);
})();
`.trim();

function minify(code: string): string {
  return code
    .replace(/\n\s*/g, "")
    .replace(/\s{2,}/g, " ");
}

export default function BookmarkletPage() {
  const minified = `javascript:${encodeURIComponent(minify(bookmarkletCode))}`;

  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="mb-4 text-2xl font-bold">Docreview Bookmarklet</h1>

      <p className="mb-6 text-muted-foreground">
        Drag the link below to your bookmarks bar. When you&apos;re on a Google
        Doc, click it to add a Docreview icon next to the document title.
      </p>

      <div className="mb-8 flex items-center gap-4 rounded-lg border bg-muted/50 p-6">
        <a
          href={minified}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
          onClick={(e) => e.preventDefault()}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <line x1="10" y1="9" x2="8" y2="9" />
          </svg>
          Docreview
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

/**
 * Docreview Bookmarklet
 * 
 * Injects a Docreview icon into the Google Docs titlebar badges area.
 * Clicking the icon opens the current document in Docreview.
 */
(function() {
  // Only run on Google Docs domain
  if (!location.hostname.endsWith('docs.google.com')) return;

  var path = location.pathname;
  // Extract document ID (match /d/ID segment)
  var m = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return;

  // Prevent duplicate injections
  if (document.getElementById('docreview-badge')) return;

  // Find the native badge row next to the title
  var badges = document.querySelector('.docs-titlebar-badges');
  if (!badges) return;

  var url = location.href;
  
  // Create container
  var container = document.createElement('div');
  container.id = 'docreview-badge';
  container.className = 'docs-titlebar-badge-container goog-inline-block';

  // Create link
  var link = document.createElement('a');
  link.href = 'http://localhost:3000/open?doc=' + encodeURIComponent(url);
  link.target = '_blank';
  link.title = 'Open in Docreview';
  link.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;text-decoration:none;vertical-align:middle;cursor:pointer;';

  // Use the Docreview icon from the server
  var img = document.createElement('img');
  img.src = 'http://localhost:3000/docreview.svg';
  img.style.cssText = 'width:18px;height:18px;border-radius:2px;';
  
  link.appendChild(img);

  // Hover effect
  link.onmouseenter = function() { link.style.opacity = '0.8'; };
  link.onmouseleave = function() { link.style.opacity = '1'; };

  // Insert at the beginning of the badges row
  badges.insertBefore(container, badges.firstChild);
  container.appendChild(link);
})();

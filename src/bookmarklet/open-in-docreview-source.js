/**
 * Docreview "Open in Docreview" Bookmarklet
 *
 * When clicked on a Google Docs/Sheets/Slides page, opens the document
 * in Docreview. Shows an error if not on a supported page.
 */
(function() {
  var url = location.href;
  if (/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]+/.test(url)) {
    window.open('__BASE_URL__/open?doc=' + encodeURIComponent(url), '_blank');
  } else {
    alert('Not a supported document');
  }
})();

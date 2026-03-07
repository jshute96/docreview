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
  } else if (/mail\.google\.com/.test(url)) {
    var chip = document.querySelector('[data-docurl]');
    if (chip) {
      window.open('__BASE_URL__/open?doc=' + encodeURIComponent(chip.getAttribute('data-docurl')), '_blank');
    } else {
      alert('No document link found in this email');
    }
  } else {
    alert('Not a supported document');
  }
})();

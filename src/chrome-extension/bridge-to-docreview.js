// Bridge to Docreview — Content script for Docreview app pages
//
// Bridges communication between the web app and the extension's background
// service worker using window.postMessage. This avoids the need for the web
// page to know the extension ID (which changes for unpacked extensions).
//
// The web page sends: { source: 'docreview-page', id, type, ... }
// This script relays to the background worker via chrome.runtime.sendMessage,
// then posts the response back: { source: 'docreview-extension', id, response }

(function() {
  // Unique ID for this page instance — used to scope cancellation so that
  // cancelling a resolve in one tab doesn't affect other tabs.
  var pageId = Math.random().toString(36).slice(2);

  // Handle unsolicited messages from the background worker and relay them to
  // the Docreview web app via window.postMessage.
  //
  // commentSynced: background → here → web app.
  //   Sent after the server-side comment sync completes (the background
  //   already called POST /api/docs/sync-comments/{docId} with the specific
  //   commentId). Carries docId plus optional googleCommentId and commentType
  //   so the web app can do a targeted single-comment fetch instead of
  //   reloading all comments.
  //
  // commentSelection: Docs page (MAIN world) → content.js → background → here → web app.
  //   Carries a discoId identifying which specific comment the user
  //   selected/deselected in the document, so the web app can highlight the row.
  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg.type === 'commentSynced' && msg.docId) {
      console.log('[bridge-to-docreview] relaying commentSynced for', msg.docId);
      var payload = { source: 'docreview-extension', type: 'commentSynced', docId: msg.docId };
      if (msg.googleCommentId) payload.googleCommentId = msg.googleCommentId;
      if (msg.commentType) payload.commentType = msg.commentType;
      if (msg.threads) payload.threads = msg.threads;
      window.postMessage(payload, '*');
      sendResponse({ received: true });
      return true;
    }
    if (msg.type === 'commentSelection') {
      window.postMessage({ source: 'docreview-extension', type: 'commentSelection', docId: msg.docId, discoId: msg.discoId, selected: msg.selected }, '*');
      sendResponse({ received: true });
      return true;
    }
  });

  // Relay messages from the Docreview web app to the background worker.
  // Flow: web app → here → background → (action, e.g. inject script into Docs tab).
  // Attaches pageId so the background can scope operations per tab.
  window.addEventListener('message', async function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'docreview-page') return;

    var id = event.data.id;
    var fireAndForget = event.data.fireAndForget;
    var msg = Object.assign({}, event.data, { pageId: pageId });
    try {
      var response = await chrome.runtime.sendMessage(msg);
      if (!fireAndForget) {
        window.postMessage({ source: 'docreview-extension', id: id, response: response }, '*');
      }
    } catch (err) {
      if (!fireAndForget) {
        window.postMessage({ source: 'docreview-extension', id: id, error: err.message }, '*');
      }
    }
  });
})();

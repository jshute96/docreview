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

  // Handle unsolicited messages from the background worker (e.g. comment sync
  // notifications) and relay them to the web page via window.postMessage.
  chrome.runtime.onMessage.addListener(function(msg, _sender, sendResponse) {
    if (msg.type === 'commentSynced' && msg.docId) {
      console.log('[bridge-to-docreview] relaying commentSynced for', msg.docId);
      window.postMessage({ source: 'docreview-extension', type: 'commentSynced', docId: msg.docId }, '*');
      sendResponse({ received: true });
      return true;
    }
  });

  // Relay messages from the web page to the background worker.
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

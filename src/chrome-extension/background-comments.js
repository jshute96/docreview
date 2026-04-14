// Comment sync state and helpers for the background service worker.
//
// Manages pre-extracted comment IDs (from content script → background
// disco ID extraction) and the debounced comment sync that fires
// server-side sync-comments API calls.

// Pre-extracted comment IDs, keyed by tab ID. Stores a Promise that resolves
// to the ID (or null). Set by commentPre handler, awaited by commentActivity.
// Also cleaned up by tab removal listener in background-tabs.js.
var pendingCommentIds = new Map();

// --- Comment activity debounce ---
// When the content script detects comment activity on a Google Docs page,
// it sends a commentActivity message with { docId, commentType, googleCommentId? }.
// We debounce per (docId, commentId) — actions on different comments fire
// independently, so resolving comment A then replying to comment B within 1s
// both get their own fast single-comment syncs. Actions without a commentId
// (e.g., suggestion accept/reject, or comment without disco URL) debounce at
// doc level and do a full sync on trailing.
//
// Leading+trailing: fire immediately on the first event, then suppress for 1s.
// If more events arrive during cooldown, fire once more when it expires.
var commentSyncTimers = new Map(); // key -> { timerId, pending, commentType?, googleCommentId? }
var COMMENT_SYNC_COOLDOWN = 1000;

function syncLabel(commentType, googleCommentId) {
  var parts = [];
  if (commentType === 'suggestion') parts.push('suggestion');
  if (googleCommentId) parts.push(googleCommentId);
  return parts.length > 0 ? ' (' + parts.join(' ') + ')' : '';
}

// Send a message to a docreview tab, trying each tab in order until one
// succeeds. The web app tab that receives the message broadcasts it via
// BroadcastChannel to all other open Docreview tabs, so we only need one
// bridge to accept it. Returns a Promise that resolves to true if any tab
// accepted the message, false if all failed.
function sendToFirstAvailableTab(tabs, msg, docId) {
  return new Promise(function(resolve) {
    function tryTab(index) {
      if (index >= tabs.length) {
        console.warn('[background] sendMessage(' + msg.type + ') failed for docId', docId,
          '— all', tabs.length, 'docreview tab(s) rejected the message (content scripts may be orphaned)');
        resolve(false);
        return;
      }
      var tab = tabs[index];
      chrome.tabs.sendMessage(tab.id, msg, function() {
        if (chrome.runtime.lastError) {
          // Only warn for fully loaded tabs — loading/discarded tabs are expected
          // to reject messages (their content scripts aren't ready yet).
          if (tab.status === 'complete') {
            console.warn('[background] sendMessage(' + msg.type + ') failed for docId', docId,
              'to tab', tab.id, ', trying next tab...');
          }
          tryTab(index + 1);
        } else {
          resolve(true);
        }
      });
    }
    tryTab(0);
  });
}

function notifyDocreviewTabs(baseUrl, docId, commentType, googleCommentId, threads) {
  chrome.tabs.query({ url: baseUrl + '/*' }, function(tabs) {
    if (tabs && tabs.length > 0) {
      var syncedMsg = { type: 'commentSynced', docId: docId };
      if (googleCommentId) syncedMsg.googleCommentId = googleCommentId;
      if (commentType) syncedMsg.commentType = commentType.toUpperCase();
      if (threads) syncedMsg.threads = threads;
      sendToFirstAvailableTab(tabs, syncedMsg, docId);
    } else {
      console.log('[background] no docreview tabs open, skipping commentSynced notification');
    }
  });
}

function fireCommentSync(docId, commentType, googleCommentId) {
  chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl }, function(config) {
    var url = config.baseUrl + '/api/docs/sync-comments/' + docId;
    var body = {};
    if (commentType) body.commentType = commentType;
    if (googleCommentId) body.googleCommentId = googleCommentId;
    var fetchOpts = { method: 'POST', credentials: 'include' };
    if (commentType || googleCommentId) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(body);
    }
    var label = syncLabel(commentType, googleCommentId);
    var t0 = Date.now();
    fetch(url, fetchOpts).then(function(res) {
      var elapsed = Date.now() - t0;
      if (res.ok) {
        console.log('[background] comment sync succeeded for', docId + label, '(' + elapsed + 'ms)');
        // Parse response for inline thread data (single-comment sync).
        // On parse failure, still notify tabs without thread data.
        return res.json().then(function(data) {
          notifyDocreviewTabs(config.baseUrl, docId, commentType, googleCommentId, data.threads);
        }).catch(function() {
          notifyDocreviewTabs(config.baseUrl, docId, commentType, googleCommentId);
        });
      } else {
        console.warn('[background] comment sync failed for', docId + label, 'status:', res.status, '(' + elapsed + 'ms)');
      }
    }).catch(function(err) {
      var elapsed = Date.now() - t0;
      console.warn('[background] comment sync error for', docId + label, '(' + elapsed + 'ms)', err);
    });
  });
}

// Comment activity detection and selection relay for Google Docs pages.
//
// setupCommentActivityDetection: Detects when the user adds, replies to,
// resolves, or accepts/rejects a comment/suggestion, and notifies the
// background worker so it can sync the change back to Docreview's database.
//
// setupCommentSelectionRelay: Relays comment selection changes from the
// MAIN world (injected disco ID helpers) to the background worker so it
// can notify Docreview tabs for cross-tab highlighting.

// Detect comment/suggestion actions on a Google Docs page.
// getCommentSyncEnabled is a callback returning the current enabled state,
// since the setting can change at runtime via chrome.storage.onChanged.
function setupCommentActivityDetection(getCommentSyncEnabled) {
  var path = location.pathname;
  var m = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return;
  var googleDocId = m[1];

  // Check whether a button is inside a suggestion thread by looking for
  // Accept/Reject buttons in the same [role="listitem"] container.
  // Suggestions have these buttons; regular comments don't.
  function isSuggestionThread(el) {
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (p.getAttribute('role') === 'listitem') {
        return !!p.querySelector('[aria-label="Accept suggestion"], [aria-label="Reject suggestion"]');
      }
    }
    return false;
  }

  // Mark a listitem ancestor of `el` with data-docreview-extract and send
  // commentPre to background for disco ID extraction. Returns true if a
  // listitem was found and marked.
  function markListitemForExtraction(el) {
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (p.getAttribute('role') === 'listitem') {
        p.setAttribute('data-docreview-extract', '');
        try {
          chrome.runtime.sendMessage({ type: 'commentPre', docId: googleDocId });
        } catch(e) {
          console.log('[docreview] extension context invalidated, skipping commentPre');
        }
        return true;
      }
    }
    return false;
  }

  // Pending observer — tracks an active MutationObserver waiting for Google
  // to finish processing a comment action. If a new action arrives while one
  // is pending, the old observer is disconnected (the new one will catch it).
  var pendingObserver = null;
  var pendingTimeout = null;

  // Set by mousedown handler when it successfully marks a listitem for ID
  // extraction. Consumed by notifyCommentActivity on the subsequent mouseup.
  var preExtractedOnMousedown = false;

  // Extract disco ID on mousedown — before Google's handler runs on mouseup,
  // which may remove the element (e.g., resolve hides the comment, accept/reject
  // removes the suggestion). Works for all button types including suggestions.
  document.addEventListener('mousedown', function(e) {
    if (!getCommentSyncEnabled()) return;
    preExtractedOnMousedown = false;
    var target = e.target;
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      var aria = el.getAttribute('aria-label');
      if (!aria) continue;
      if (aria === 'Reply to comment' || aria === 'Post Comment' ||
          aria === 'Mark as resolved and hide discussion' ||
          aria === 'Accept suggestion' || aria === 'Reject suggestion') {
        preExtractedOnMousedown = markListitemForExtraction(el);
        return;
      }
      if (el.getAttribute('role') === 'listitem') break;
    }
  }, true);

  function notifyCommentActivity(action, commentType) {
    if (!getCommentSyncEnabled()) return;

    var foundListitem = preExtractedOnMousedown;
    preExtractedOnMousedown = false;

    var detail = commentType === 'suggestion' ? action + ' suggestion' : action;
    if (foundListitem) detail += ' (extracting ID)';
    console.log('[docreview] comment activity detected:', detail, googleDocId);

    // Clean up any pending observer from a previous action
    if (pendingObserver) {
      pendingObserver.disconnect();
      pendingObserver = null;
    }
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }

    function sendNotification() {
      if (pendingObserver) {
        pendingObserver.disconnect();
        pendingObserver = null;
      }
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
      }
      console.log('[docreview] comment action confirmed, notifying:', commentType === 'suggestion' ? action + ' suggestion' : action, googleDocId);
      try {
        chrome.runtime.sendMessage({ type: 'commentActivity', docId: googleDocId, commentType: commentType });
      } catch(e) {
        console.log('[docreview] extension context invalidated, skipping commentActivity notification');
      }
    }

    // Watch the comment list for DOM changes — Google updates the DOM once
    // the action is saved (reply appears, comment removed on resolve, etc.)
    var commentList = document.querySelector('[role="list"]');
    if (!commentList) {
      // No comment list found — wait briefly for Google to save, then notify
      pendingTimeout = setTimeout(sendNotification, 500);
      return;
    }

    // Whether we need to wait for a new listitem to appear (new comment case).
    // When true, don't fire sendNotification until the listitem is found.
    var waitingForListitem = !foundListitem && commentType === 'comment';

    pendingObserver = new MutationObserver(function(mutations) {
      // For new comments (no pre-extracted ID), the new listitem appears in
      // the mutation's addedNodes. Mark it so background can extract the disco ID.
      if (waitingForListitem) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType === 1 && node.getAttribute && node.getAttribute('role') === 'listitem') {
              markListitemForExtraction(node);
              foundListitem = true;
              waitingForListitem = false;
              break;
            }
          }
          if (!waitingForListitem) break;
        }
        // Keep observing until the new listitem appears
        if (waitingForListitem) return;
      }
      sendNotification();
    });
    pendingObserver.observe(commentList, { childList: true, subtree: true, attributes: true });

    // Fallback timeout in case no mutation fires (e.g., action failed silently)
    // or the new listitem never appeared
    pendingTimeout = setTimeout(function() {
      if (waitingForListitem) {
        console.log('[docreview] timeout waiting for new comment listitem, notifying without ID:', action);
      } else {
        console.log('[docreview] timeout waiting for DOM change, notifying anyway:', action);
      }
      sendNotification();
    }, 3000);
  }

  // Catch actions on comment buttons via event delegation on mouseup.
  // Google's Closure Library handles these buttons on mousedown/mouseup,
  // NOT click — the click event never fires. We use mouseup in the capture
  // phase so we see the event before Google's handlers consume it.
  document.addEventListener('mouseup', function(e) {
    var target = e.target;
    // Walk up a few levels to find the button (clicks may land on child elements)
    for (var el = target; el && el !== document.body; el = el.parentElement) {
      var aria = el.getAttribute('aria-label');
      if (!aria) continue;
      // Reply / Comment submit button (can appear on both comments and suggestions)
      if (aria === 'Reply to comment' || aria === 'Post Comment') {
        // Only fire if the button is not disabled (has text typed)
        if (!el.classList.contains('jfk-button-disabled')) {
          var kind = isSuggestionThread(el) ? 'suggestion' : 'comment';
          notifyCommentActivity(aria === 'Post Comment' ? 'comment' : 'reply', kind);
        }
        return;
      }
      // Resolve (comments only — suggestions use Accept/Reject instead)
      if (aria === 'Mark as resolved and hide discussion') {
        notifyCommentActivity('resolve', 'comment');
        return;
      }
      // Accept / Reject suggestion — always a suggestion
      if (aria === 'Accept suggestion' || aria === 'Reject suggestion') {
        notifyCommentActivity(aria === 'Accept suggestion' ? 'accept' : 'reject', 'suggestion');
        return;
      }
      // Stop walking after a few levels to avoid scanning the whole tree
      if (el.getAttribute('role') === 'listitem') break;
    }
  }, true);

  // Catch Ctrl+Enter in comment/reply input areas (keyboard shortcut to submit)
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      var target = e.target;
      // Check if the focus is inside a comment input area
      for (var el = target; el && el !== document.body; el = el.parentElement) {
        if (el.classList && el.classList.contains('docos-input-textarea')) {
          var kind = isSuggestionThread(el) ? 'suggestion' : 'comment';
          preExtractedOnMousedown = markListitemForExtraction(el);
          notifyCommentActivity('ctrl+enter', kind);
          return;
        }
      }
    }
  }, true);
}

// Relay comment selection changes from MAIN world to the background worker.
// The MAIN world selection tracker (inside injectDiscoIdHelpers) posts
// messages when a comment is selected/deselected; we forward them with
// the Google Doc ID so the background can route to Docreview tabs.
function setupCommentSelectionRelay() {
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'docreview-comment-selection') return;
    // Extract the Google Doc ID from the URL path (/d/XXXXX/).
    // The MAIN world code doesn't know the doc ID — it only sees the
    // DOM — so the content script adds it here from the URL. The
    // background uses this to route to the right Docreview tab.
    var docMatch = location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!docMatch) return;
    try {
      chrome.runtime.sendMessage({
        type: 'commentSelection',
        docId: docMatch[1],
        discoId: event.data.discoId,
        selected: event.data.selected
      });
    } catch(e) {}
  });
}

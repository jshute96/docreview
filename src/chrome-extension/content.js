// Content script for Docreview Chrome Extension.
// Injects Docreview icons into Google Docs, Drive, and Gmail.
//
// Key design notes:
//   - baseUrl comes from chrome.storage.sync (configurable via options page)
//   - Icon uses chrome.runtime.getURL (works offline, no mixed-content issues)
//   - Gmail "Open in Docreview" link resolves the doc URL at click time via the
//     background service worker, not at injection time. This avoids stale URLs when
//     navigating Gmail's SPA between different emails.
//   - Gmail injection only targets Docs notification emails (identified by the
//     presence of an overview-card-contents element), not arbitrary emails with
//     doc links in the body.

(async function() {
  var settings = await chrome.storage.sync.get({
    baseUrl: DEFAULTS.baseUrl,
    enableDocs: DEFAULTS.enableDocs,
    enableCommentSync: DEFAULTS.enableCommentSync,
    enableDrive: DEFAULTS.enableDrive,
    enableGmail: DEFAULTS.enableGmail
  });
  var baseUrl = settings.baseUrl;
  var iconUrl = chrome.runtime.getURL('icons/icon16.png');

  var commentSyncEnabled = settings.enableCommentSync;
  chrome.storage.onChanged.addListener(function(changes) {
    if (changes.enableCommentSync) commentSyncEnabled = changes.enableCommentSync.newValue;
  });

  var hostname = location.hostname;
  var docsEnabled = hostname.endsWith('docs.google.com') && settings.enableDocs;
  var driveEnabled = hostname.endsWith('drive.google.com') && settings.enableDrive;
  var gmailEnabled = hostname.endsWith('mail.google.com') && settings.enableGmail;

  if (!docsEnabled && !driveEnabled && !gmailEnabled) return;

  // Create a clickable Docreview icon that opens the given doc in Docreview.
  // Used by Docs (titlebar badge) and Drive (next to file icons).
  // Event suppression on mousedown/mouseup prevents Google's own click handlers
  // from firing (e.g., selecting the file in Drive or navigating away).
  function createIconButton(docId, size, originalUrl) {
    var btn = document.createElement('div');
    var openUrl = baseUrl + '/open?doc=' + encodeURIComponent(originalUrl || ('https://docs.google.com/open?id=' + docId));

    btn.className = 'dr-link';
    btn.title = 'Open in Docreview';
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;vertical-align:middle;width:' + (size+4) + 'px;height:' + (size+4) + 'px;margin-right:4px;';

    var img = document.createElement('img');
    img.src = iconUrl;
    img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:2px;pointer-events:none;';
    btn.appendChild(img);

    var suppress = function(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    btn.addEventListener('mousedown', suppress, true);
    btn.addEventListener('mouseup', suppress, true);
    // Suppress mouseover/mouseout to prevent Drive's file preview tooltip
    // from triggering when hovering the Docreview icon (jsaction="mouseover:...")
    btn.addEventListener('mouseover', suppress, true);
    btn.addEventListener('mouseout', suppress, true);
    btn.addEventListener('click', function(e) {
      suppress(e);
      // On Google Docs pages, track this tab so comment navigation can reuse it
      // instead of opening a new one when the user clicks Open in Docreview
      if (docsEnabled && docId) {
        chrome.runtime.sendMessage({ type: 'trackDocTab', docId: docId });
      }
      window.open(openUrl, '_blank');
    }, true);

    return btn;
  }

  // Google Docs: inject a Docreview icon into the titlebar badge area.
  function injectDocs() {
    var path = location.pathname;
    var m = path.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return;
    if (document.getElementById('dr-badge')) return;

    var badges = document.querySelector('.docs-titlebar-badges');
    if (!badges) return;

    var container = document.createElement('div');
    container.id = 'dr-badge';
    container.className = 'docs-titlebar-badge-container goog-inline-block';
    // z-index ensures the icon is fully clickable (titlebar elements can overlap)
    container.style.cssText = 'position:relative;z-index:1;';

    var btn = createIconButton(m[1], 18, location.href);
    container.appendChild(btn);
    badges.insertBefore(container, badges.firstChild);
  }

  // "Access Denied" / "You need access" page: inject an "Add in Docreview" link
  // above the "Request access" button. This lets users track a document they've
  // requested access to, with a prefilled note recording the request date.
  // Works on both docs.google.com and drive.google.com access-denied pages
  // (they share the same HTML structure).
  function injectAccessDenied() {
    if (document.getElementById('dr-access-denied')) return;

    // The page has <h1 class="hA3Ymb">You need access</h1>
    var heading = document.querySelector('h1.hA3Ymb');
    if (!heading || heading.textContent !== 'You need access') return;

    // Find the button's touch wrapper (div.VfPpkd-dgl2Hf-ppHlrf-sM5MNb)
    var reqBtn = document.querySelector('button.DGBc1e');
    if (!reqBtn) return;
    var btnWrapper = reqBtn.closest('[data-is-touch-wrapper]');
    if (!btnWrapper || !btnWrapper.parentElement) return;

    // On drive.google.com access-denied pages, the URL is like
    // /drivesharing/u/0/accessdenied?...&itemId=DOC_ID&resourcekey=...
    // Construct a proper Drive URL from itemId so /add gets a usable doc link.
    var docUrl = location.href;
    if (hostname.endsWith('drive.google.com')) {
      var params = new URLSearchParams(location.search);
      var itemId = params.get('itemId');
      if (itemId) {
        docUrl = 'https://drive.google.com/open?id=' + itemId;
      }
    }

    var now = new Date();
    var today = now.getFullYear() + '-'
      + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0');
    var addUrl = baseUrl + '/add?doc=' + encodeURIComponent(docUrl)
      + '&notes=' + encodeURIComponent('You requested access on ' + today + '.');

    var bar = document.createElement('div');
    bar.id = 'dr-access-denied';
    bar.style.cssText = 'display:block;margin-bottom:12px;font-family:Google Sans,Roboto,sans-serif;font-size:14px;color:#5f6368;';

    var img = document.createElement('img');
    img.src = iconUrl;
    img.style.cssText = 'width:16px;height:16px;border-radius:2px;vertical-align:middle;margin-right:4px;';

    var link = document.createElement('a');
    link.href = addUrl;
    link.target = '_blank';
    link.style.cssText = 'color:#7c3aed;font-weight:500;text-decoration:none;';
    link.appendChild(img);
    link.appendChild(document.createTextNode('Add in Docreview'));

    bar.appendChild(link);
    btnWrapper.parentElement.insertBefore(bar, btnWrapper);
  }

  // Google Drive: inject Docreview icons next to file type icons in list and grid views.
  function injectDrive() {
    // List/search view: file rows are <tr role="row">. Using "tr" excludes the
    // <div role="row"> that wraps folder gridcells in the suggested folders section.
    var rows = document.querySelectorAll('tr[role="row"]');
    rows.forEach(function(row) {
      var nameArea = row.querySelector('[data-column-id="16"]') || row;

      if (nameArea.querySelector('.dr-link')) return;

      // Skip folders — the name element's data-tooltip ends with "folder" (e.g.,
      // "Read previously Shared folder") while files end with their type
      // (e.g., "Bike Maintenance Google Sheets").
      var nameEl = nameArea.querySelector('[data-tooltip]');
      if (nameEl && /\bfolder$/i.test(nameEl.getAttribute('data-tooltip'))) return;

      var idEl = nameArea.querySelector('[data-id]') || row.querySelector('[data-id]');
      var docId = idEl ? idEl.getAttribute('data-id') : null;

      if (docId && docId.length > 20) {
        var anchor = nameArea.querySelector('svg, img');
        if (anchor) {
          var btn = createIconButton(docId, 16);
          var parent = anchor.parentElement;
          if (window.getComputedStyle(parent).display !== 'flex') {
            parent.style.display = 'flex';
            parent.style.alignItems = 'center';
          }
          parent.insertBefore(btn, anchor);
        }
      }
    });

    // Grid view: cells with role="gridcell"
    // Skip folders (data-selection-key="2") — they can't be opened in Docreview.
    // Files use data-selection-key="1".
    var gridItems = document.querySelectorAll('[role="gridcell"][data-selection-key="1"]');
    gridItems.forEach(function(item) {
      if (item.querySelector('.dr-link')) return;

      var idEl = item.querySelector('[data-id]');
      var docId = idEl ? idEl.getAttribute('data-id') : null;

      if (docId && docId.length > 20) {
        var anchor = item.querySelector('svg, img');
        if (anchor) {
          var btn = createIconButton(docId, 16);
          var parent = anchor.parentElement;
          if (window.getComputedStyle(parent).display !== 'flex') {
            parent.style.display = 'flex';
            parent.style.alignItems = 'center';
          }
          parent.insertBefore(btn, anchor);
        }
      }
    });
  }

  // Gmail: inject Docreview icons into attachment chips (data-docurl) and an
  // "Open in Docreview" link into Docs notification emails.
  function injectGmail() {
    // Attachment chips: Drive file attachments in the inbox list view have a
    // data-docurl attribute with the file's URL. Inject an icon next to the
    // file type icon.
    var chips = document.querySelectorAll('[data-docurl]');
    chips.forEach(function(chip) {
      if (chip.querySelector('.dr-link')) return;
      var docUrl = chip.getAttribute('data-docurl');
      if (!docUrl) return;
      var anchor = chip.querySelector('img');
      if (!anchor) return;
      var btn = createIconButton(null, 16, docUrl);
      btn.style.marginRight = '0';
      btn.style.marginLeft = '2px';
      chip.style.display = 'inline-flex';
      chip.style.alignItems = 'center';
      anchor.parentElement.insertBefore(btn, anchor);
    });

    // Notification emails: Google Docs comment/suggestion notifications contain
    // an "overview-card-contents" div with the document title and comment text.
    // Non-AMP notifications render this directly in the top-level DOM; AMP ones
    // render it inside a sandboxed iframe (which content scripts can't access).
    //
    // We insert a static "Open in Docreview" link that resolves the doc URL at
    // click time via the background service worker. This avoids stale URLs when
    // Gmail's SPA navigation reuses DOM elements between different emails.
    //
    // We only inject into notification emails (identified by overview-card-contents
    // or an AMP iframe) to avoid cluttering regular emails that happen to contain
    // doc links.
    if (window === window.top) {
      var msgDivs = document.querySelectorAll('[data-message-id]');
      msgDivs.forEach(function(msgDiv) {
        if (msgDiv.querySelector('.dr-gmail-bar')) return;

        // overview-card-contents: present in Docs notification emails.
        // ID is prefixed with a message-specific string in non-AMP emails
        // (e.g., "m_12345overview-card-contents"), so we match the suffix.
        var overviewCard = msgDiv.querySelector('[id$="overview-card-contents"]');
        // AMP iframe: present in some notification emails where the content
        // is rendered inside a sandboxed cross-origin iframe.
        var iframe = msgDiv.querySelector('iframe');
        if (!overviewCard && !iframe) return;

        var insertParent, insertBefore, insideContent;
        if (overviewCard) {
          // Non-AMP: insert inside the email content, above the heading
          insertParent = overviewCard;
          insertBefore = overviewCard.firstChild;
          insideContent = true;
        } else {
          // AMP: insert above the iframe in the top-level frame
          insertParent = iframe.parentElement;
          insertBefore = iframe;
          insideContent = false;
        }

        insertDocreviewLink(insertParent, insertBefore, insideContent);
      });
    }
  }

  // Insert an "Open in Docreview" link. The link doesn't contain a pre-baked URL;
  // instead, clicking it sends a message to the background service worker which
  // searches all frames for doc URLs at that moment. This is necessary because
  // Gmail's SPA reuses DOM elements, so a URL captured at injection time can become
  // stale when the user navigates to a different email.
  function insertDocreviewLink(parent, beforeEl, insideContent) {
    var bar = document.createElement('div');
    bar.className = 'dr-gmail-bar';
    if (insideContent) {
      // Inside the email content area: simple block styling
      bar.style.cssText = 'display:block;padding:0 0 8px 0;font-family:Google Sans,Roboto,sans-serif;font-size:14px;color:#5f6368;';
    } else {
      // Above the iframe: match the AMP email content's width/centering
      // (width:90%, max-width:700px, margin:auto — from Gmail's AMP template)
      bar.style.cssText = 'width:90%;max-width:700px;min-width:280px;margin:0 auto;padding:8px 0 0 0;margin-bottom:-14px;font-family:Google Sans,Roboto,sans-serif;font-size:16px;color:#5f6368;text-align:left;position:relative;z-index:1;';
    }
    bar.appendChild(document.createTextNode('Open in '));
    // Use a <span> not <a> — an <a href="#"> would show the Gmail URL on hover
    var link = document.createElement('span');
    link.style.cssText = 'color:#7c3aed;font-weight:500;vertical-align:middle;cursor:pointer;';
    link.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'openDocInDocreview' });
    });
    var img = document.createElement('img');
    img.src = iconUrl;
    img.style.cssText = 'width:16px;height:16px;border-radius:2px;vertical-align:middle;margin-right:3px;';
    link.appendChild(img);
    link.appendChild(document.createTextNode('Docreview'));
    bar.appendChild(link);
    parent.insertBefore(bar, beforeEl);
  }

  // --- Comment activity detection (Docs only) ---
  // Detects when the user adds, replies to, resolves, or accepts/rejects a
  // comment, and notifies the background worker so it can sync the change
  // back to Docreview's database.
  function setupCommentActivityDetection() {
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
      if (!commentSyncEnabled) return;
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
      if (!commentSyncEnabled) return;

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

  // Set up injection and MutationObservers. Google Workspace apps load content
  // dynamically, so we need observers to inject into elements that appear after
  // the initial page load (titlebar in Docs, file list in Drive, emails in Gmail).
  if (docsEnabled) {
    injectDocs();
    injectAccessDenied();
    if (commentSyncEnabled) setupCommentActivityDetection();
    new MutationObserver(function() { injectDocs(); injectAccessDenied(); }).observe(document.body, { childList: true, subtree: true });
  } else if (driveEnabled) {
    injectDrive();
    injectAccessDenied();
    new MutationObserver(function() { injectDrive(); injectAccessDenied(); }).observe(document.body, { childList: true, subtree: true });
  } else if (gmailEnabled) {
    injectGmail();
    new MutationObserver(injectGmail).observe(document.body, { childList: true, subtree: true });
  }

  console.log('Docreview extension active');
})();

// Functions injected into page context via chrome.scripting.executeScript.
// These run in the page's JS environment, not in the service worker — they
// can access the page's DOM and Closure Library internals but cannot use
// chrome.* APIs.

// Injected into page frames via executeScript to find Google Docs/Sheets/Slides URLs.
// Deduplicates by document ID since the same doc appears in multiple links
// (chip, "Open" button, notification settings, etc.) with different query params.
function findDocUrlsInFramesFunc() {
  var urls = [];
  var seenIds = {};

  function addUrl(raw) {
    var m = raw.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
    if (!m) return;
    var id = m[2];
    if (seenIds[id]) return;
    seenIds[id] = true;
    urls.push('https://docs.google.com/' + m[1] + '/d/' + id + '/edit');
  }

  // In the top-level Gmail frame, scope the search to only expanded (visible) messages.
  // Gmail is a SPA that keeps collapsed and previously-viewed messages in the DOM,
  // so searching the whole document would find doc links from other emails.
  var searchRoots = [];
  if (window === window.top) {
    var msgDivs = document.querySelectorAll('[data-message-id]');
    msgDivs.forEach(function(el) {
      if (el.offsetHeight > 0) searchRoots.push(el);
    });
    if (searchRoots.length === 0) searchRoots.push(document);
  } else {
    // In subframes (including sandboxed AMP iframes), search the whole document
    searchRoots.push(document);
  }

  searchRoots.forEach(function(root) {
    // Drive attachment chips use data-docurl attributes
    var chip = root.querySelector('[data-docurl]');
    if (chip) addUrl(chip.getAttribute('data-docurl') || '');

    // Notification emails have <a> tags linking to the doc
    var links = root.querySelectorAll('a[href*="docs.google.com/document/d/"], a[href*="docs.google.com/spreadsheets/d/"], a[href*="docs.google.com/presentation/d/"]');
    for (var i = 0; i < links.length; i++) {
      addUrl(links[i].href);
    }
  });
  return urls;
}

// --- Disco ID extraction (injected into page context) ---
//
// Google Docs stores a disco ID for each comment/suggestion listitem in the
// Closure Library component tree (accessible via closure_lm properties on DOM
// elements). These scripts are injected into the page's JS context via
// chrome.scripting.executeScript — content scripts can't access these properties.
//
// injectDiscoIdHelpers sets up window.__docreviewDisco.getDiscoId(item), which
// is used by both extractCommentIdFromPage and navigateToCommentInPage.

// Injected once per page to set up the shared getDiscoId helper on window.
// Idempotent — skips if already injected.
function injectDiscoIdHelpers() {
  if (window.__docreviewDisco) return;

  // The disco ID for each comment listitem is stored in Google's Closure Library
  // component tree under minified property names (e.g., .Yd.Ai) that change when
  // Google releases new code. Instead of hardcoding these names, we discover the
  // path dynamically by walking the tree and looking for AAAB-pattern strings.
  //
  // Discovery strategy:
  //   - With 2+ items: diff two items' trees. Paths that exist in both but have
  //     different values are per-item IDs. Paths through array indices contain the
  //     shared model array (all IDs) — filter those out.
  //   - With 1 item: find the shortest path to an AAAB string that doesn't traverse
  //     an array index. The shared array goes through numeric indices; the per-item
  //     ID is at a short, direct property path.
  //
  // The discovered path is cached across calls for the lifetime of the page.

  var discoveredIdPath = null;

  // Walk an object tree collecting paths to AAAB-pattern strings.
  // Each result: { path: string[], value, throughArray: boolean }
  // throughArray is true if any step in the path was a numeric array index.
  function collectIdPaths(obj, maxDepth) {
    var results = [];
    var seen = new WeakSet();
    function walk(cur, path, depth, throughArray) {
      if (depth > maxDepth || !cur) return;
      if (typeof cur === 'object') {
        if (seen.has(cur)) return;
        seen.add(cur);
      }
      var keys = Object.keys(cur);
      for (var i = 0; i < keys.length && i < 200; i++) {
        var key = keys[i];
        var isNum = /^\d+$/.test(key);
        try {
          var v = cur[key];
          if (typeof v === 'string' && /^AAAB[A-Za-z0-9_-]{5,}$/.test(v) && v.length < 20) {
            results.push({
              path: isNum ? path.concat('*') : path.concat(key),
              value: v,
              throughArray: throughArray || isNum
            });
          }
          if (typeof v === 'object' && v !== null && !(v instanceof HTMLElement) && !(v instanceof Window)) {
            walk(v, isNum ? path.concat('*') : path.concat(key), depth + 1, throughArray || isNum);
          }
        } catch(e) {}
      }
    }
    walk(obj, [], 0, false);
    return results;
  }

  function getClickRoot(item) {
    var lk = Object.keys(item).find(function(k) { return k.startsWith('closure_lm'); });
    if (!lk) return null;
    try { return item[lk].listeners.click[0]; } catch(e) { return null; }
  }

  // Discover the property path to the per-item disco ID.
  function discoverIdPath(items) {
    if (items.length >= 2) {
      var root0 = getClickRoot(items[0]);
      var root1 = getClickRoot(items[1]);
      if (!root0 || !root1) return null;
      var paths0 = collectIdPaths(root0, 4);
      var paths1 = collectIdPaths(root1, 4);
      var map0 = {}, map1 = {};
      paths0.forEach(function(p) { if (!p.throughArray) map0[p.path.join('.')] = p.value; });
      paths1.forEach(function(p) { if (!p.throughArray) map1[p.path.join('.')] = p.value; });
      var candidates = [];
      for (var key in map0) {
        if (map1[key] && map0[key] !== map1[key]) candidates.push(key);
      }
      candidates.sort(function(a, b) { return a.length - b.length; });
      if (candidates.length > 0) return candidates[0].split('.');
    } else if (items.length === 1) {
      var root = getClickRoot(items[0]);
      if (!root) return null;
      var paths = collectIdPaths(root, 4);
      var nonArray = paths.filter(function(p) { return !p.throughArray; });
      nonArray.sort(function(a, b) { return a.path.length - b.path.length; });
      if (nonArray.length > 0) return nonArray[0].path;
    }
    return null;
  }

  // Extract the disco ID from an item using a known property path.
  function extractIdByPath(item, pathParts) {
    try {
      var cur = getClickRoot(item);
      if (!cur) return null;
      for (var i = 0; i < pathParts.length; i++) cur = cur[pathParts[i]];
      return (typeof cur === 'string' && /^AAAB/.test(cur)) ? cur : null;
    } catch(e) { return null; }
  }

  // Get the disco ID for a [role="listitem"] element. Discovers the property
  // path on first call (or re-discovers if the cached path fails).
  function getDiscoId(item) {
    if (discoveredIdPath) {
      var id = extractIdByPath(item, discoveredIdPath);
      if (id) return id;
    }
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var newPath = discoverIdPath(items);
    if (newPath) {
      discoveredIdPath = newPath;
      var id = extractIdByPath(item, newPath);
      if (id) return id;
    }
    return null;
  }

  // List all visible comments/suggestions with their disco IDs and text.
  // Call from the Google Docs page console for debugging: listComments()
  function listComments() {
    var skip = /^(Loading\.\.\.|New|Approver|Show more|Show less|Suggestion was deleted|Reply was deleted|Comment details cannot be verified|\d+ repl(y|ies))$/;

    function extractText(item, author) {
      var divs = item.querySelectorAll('div');
      for (var j = 0; j < divs.length; j++) {
        var t = (divs[j].textContent || '').trim();
        // Skip short text (timestamps, "New"), UI boilerplate, and author names
        if (t.length <= 3 || skip.test(t) || t === author) continue;
        // Non-leaf divs contain aggregated text from children — skip them
        // unless they match a suggestion action pattern (Replace/Add/Delete),
        // which is how Google renders suggestion descriptions.
        if (divs[j].children.length > 0) {
          if (/^(Replace|Add|Delete):/.test(t)) return t.substring(0, 60);
          continue;
        }
        // First leaf div with meaningful text is the comment body
        return t.substring(0, 60);
      }
      return '';
    }

    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var results = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = getDiscoId(item) || '(no ID)';
      var label = item.getAttribute('aria-label') || '';
      var type = label.indexOf('Suggestions') === 0 ? 'suggestion' : 'comment';
      var authorMatch = label.match(/Author ([^.]+)\./);
      var author = authorMatch ? authorMatch[1] : '?';
      var text = extractText(item, author);
      results.push({ id: id, type: type, author: author, text: text });
      console.log('[' + i + '] ' + type + ' ' + id + '  ' + JSON.stringify(text));
    }
    return results;
  }

  // List all visible suggestions with detailed info: disco ID, suggestion type,
  // old/new text, status (open/accepted/rejected), author, timestamp, and
  // replies with author/timestamp/text.
  // Call from the Google Docs page console for debugging: getSuggestions()
  //
  // When the comments pane is open, the same suggestion appears in both the
  // anchored sidebar (docos-anchoreddocoview) and the pane (docos-streamdocoview).
  // We deduplicate by disco ID, preferring the anchored version for open
  // suggestions (richer DOM) and the stream version for resolved ones (only
  // place they appear).
  function getSuggestions() {
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var seenIds = {};
    var results = [];

    // Get the logged-in user's display name from the Google Account button
    // (e.g., "Google Account: Dave (docreview.dave@gmail.com)").
    var myName = '';
    var accountBtn = document.querySelector('[aria-label*="Google Account"]');
    if (accountBtn) {
      var nameMatch = (accountBtn.getAttribute('aria-label') || '').match(/Google Account:\s*([^(]+)\s*\(/);
      if (nameMatch) myName = nameMatch[1].trim();
    }

    // Helper: extract reply body from either anchored or stream view.
    // Returns { text, html }. Anchored view uses .docos-replyview-body;
    // stream view uses .docos-replyview-body-container (the -body div
    // exists but is empty).
    function getReplyBody(replyEl) {
      var body = replyEl.querySelector('.docos-replyview-body');
      var text = body ? body.textContent.trim() : '';
      var html = body ? body.innerHTML.trim() : '';
      if (!text) {
        var container = replyEl.querySelector('.docos-replyview-body-container');
        if (container) {
          text = container.innerText.trim();
          html = container.innerHTML.trim();
        }
      }
      return { text: text, html: html };
    }

    // Helper: extract author name from a reply entry.
    function getReplyAuthor(replyEl) {
      var d = replyEl.querySelector('.docos-author');
      return d ? d.textContent.trim() : '';
    }

    // Helper: extract timestamp from a reply entry.
    // Anchored view stores it in a div with class containing "authortimestamp";
    // stream view uses a div with class containing "timestamp" (e.g.,
    // docos-streamdocoview-timestamp). Look for the first unstyled <span>
    // inside either container.
    function getReplyTimestamp(replyEl) {
      var ts = replyEl.querySelector('[class*="authortimestamp"]') ||
               replyEl.querySelector('[class*="timestamp"]');
      if (!ts) return '';
      var spans = ts.querySelectorAll('span');
      for (var i = 0; i < spans.length; i++) {
        var t = spans[i].textContent.trim();
        if (t && !spans[i].getAttribute('style')) return t;
      }
      return '';
    }

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var label = item.getAttribute('aria-label') || '';
      if (label.indexOf('Suggestions') !== 0) continue;

      var id = getDiscoId(item) || '(no ID)';

      // Deduplicate: skip if we already have this suggestion from a richer source.
      // Prefer anchored entries for open suggestions (more DOM detail),
      // but accept stream entries for resolved ones (only source).
      var isAnchored = item.classList.contains('docos-anchoreddocoview');
      if (seenIds[id]) {
        if (isAnchored) {
          // Replace the stream version with this anchored version
          results = results.filter(function(r) { return r.id !== id; });
        } else {
          continue; // already have anchored version
        }
      }
      seenIds[id] = true;

      // Parse suggestion type and old/new text from styled description spans
      var descDiv = item.querySelector('.docos-replyview-body div[style*="font-size:13px"]');
      var suggestionType = '', oldText = '', newText = '';
      if (descDiv) {
        var actionSpan = descDiv.querySelector('span[style*="font-weight:bold"]');
        if (actionSpan) suggestionType = actionSpan.textContent.trim().replace(':', '');
        var italicSpans = descDiv.querySelectorAll('span[style*="font-style:italic"]');
        if (suggestionType === 'Replace' && italicSpans.length >= 2) {
          oldText = italicSpans[0].textContent.replace(/[\u201c\u201d]/g, '');
          newText = italicSpans[1].textContent.replace(/[\u201c\u201d]/g, '');
        } else if (suggestionType === 'Add' && italicSpans.length >= 1) {
          newText = italicSpans[0].textContent.replace(/[\u201c\u201d]/g, '');
        } else if (suggestionType === 'Delete' && italicSpans.length >= 1) {
          oldText = italicSpans[0].textContent.replace(/[\u201c\u201d]/g, '');
        }
      }

      // Determine status: open, accepted, or rejected.
      // Open suggestions have Accept/Reject buttons. Resolved ones have the
      // docos-docoview-resolved class and a final reply with status text
      // ("Suggestion accepted" or "Suggestion rejected").
      var status = 'open';
      if (item.classList.contains('docos-docoview-resolved') ||
          !item.querySelector('[aria-label="Accept suggestion"]')) {
        // Check the last reply's text for accepted/rejected
        var innerText = item.innerText || '';
        if (innerText.indexOf('Suggestion accepted') !== -1) {
          status = 'accepted';
        } else if (innerText.indexOf('Suggestion rejected') !== -1) {
          status = 'rejected';
        }
      }

      // Extract author and timestamp from the first (suggestion) entry.
      // Anchored view uses .docos-replyview-first; stream view (especially
      // for resolved suggestions) may not have that class, so fall back to
      // the content container and aria-label for the author.
      var firstEntry = item.querySelector('.docos-replyview-first');
      var author = '', timestamp = '';
      if (firstEntry) {
        author = getReplyAuthor(firstEntry);
        timestamp = getReplyTimestamp(firstEntry);
      }
      if (!author || !timestamp) {
        var contentDiv = item.querySelector('[class*="streamdocoview-content"]');
        if (contentDiv) {
          if (!author) {
            var cd = contentDiv.querySelector('.docos-author');
            if (cd) author = cd.textContent.trim();
          }
          if (!timestamp) {
            var ct = contentDiv.querySelector('[class*="timestamp"]');
            if (ct) {
              var ctSpans = ct.querySelectorAll('span');
              for (var cs = 0; cs < ctSpans.length; cs++) {
                var cst = ctSpans[cs].textContent.trim();
                if (cst && !ctSpans[cs].getAttribute('style')) { timestamp = cst; break; }
              }
            }
          }
        }
        // Last resort: author from aria-label
        if (!author) {
          var authorMatch = label.match(/Author ([^.]+)\./);
          if (authorMatch) author = authorMatch[1];
        }
      }

      // Extract replies (all docos-replyview entries after the first/suggestion one)
      var replyEntries = item.querySelectorAll('.docos-replyview');
      var replies = [];
      for (var r = 0; r < replyEntries.length; r++) {
        if (replyEntries[r].classList.contains('docos-replyview-first')) continue;
        var rBody = getReplyBody(replyEntries[r]);
        if (!rBody.text) continue;
        var rAuthor = getReplyAuthor(replyEntries[r]);
        // System status entries become action replies (like resolve/reopen for comments).
        // The body text may include "Show more"/"Show less" from collapsible UI elements,
        // so use startsWith rather than exact match.
        var rAction = undefined;
        if (rBody.text.indexOf('Suggestion accepted') === 0) rAction = 'accept';
        else if (rBody.text.indexOf('Suggestion rejected') === 0) rAction = 'reject';
        replies.push({
          author: rAuthor,
          isMine: !!(myName && rAuthor === myName),
          timestamp: getReplyTimestamp(replyEntries[r]),
          text: rAction ? '' : rBody.text,
          html: !rAction && rBody.html !== rBody.text ? rBody.html : undefined,
          action: rAction
        });
      }

      var entry = {
        id: id,
        suggestionType: suggestionType,
        status: status,
        oldText: oldText,
        newText: newText,
        author: author,
        isMine: !!(myName && author === myName),
        timestamp: timestamp,
        replies: replies
      };
      results.push(entry);
      console.log('[' + results.length + '] ' + status + ' ' + suggestionType + ' ' + id +
        (entry.isMine ? ' (mine)' : '') +
        '  ' + JSON.stringify(oldText ? oldText.substring(0, 30) : '') +
        ' → ' + JSON.stringify(newText ? newText.substring(0, 30) : '') +
        (replies.length ? '  (' + replies.length + ' replies)' : ''));
    }
    return results;
  }

  // Get the disco ID of the currently selected/active comment.
  function getActiveCommentId() {
    var active = document.querySelector('#docos-stream-view [role="listitem"].docos-docoview-active');
    if (!active) { console.log('No active comment'); return null; }
    var id = getDiscoId(active);
    console.log('Active comment:', id || '(no ID)');
    return id;
  }

  // --- Comment navigation helpers ---
  // Shared by selectCommentInPage and navigateToCommentInPage. Exposed on
  // window.__docreviewDisco so injected scripts can use them without
  // duplicating code.

  // Google Docs buttons require a full mousedown+mouseup+click sequence;
  // a bare .click() is ignored by the Closure event system.
  function fullClick(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // Comments pane management. The pane has class docs-docos-activity-sidebar.
  // There are multiple [role="complementary"] elements; must use the specific class.
  function isCommentsPaneOpen() {
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    return !!(panel && panel.offsetParent !== null);
  }

  function openCommentsPane() {
    if (isCommentsPaneOpen()) return Promise.resolve();
    console.log('[docreview] opening comments pane');
    var btn = document.querySelector('[aria-label*="Show all comments"]');
    if (!btn) return Promise.resolve();
    fullClick(btn);
    return new Promise(function(resolve) {
      var attempts = 0;
      var check = setInterval(function() {
        if (isCommentsPaneOpen() || ++attempts > 15) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  function closeCommentsPane() {
    if (!isCommentsPaneOpen()) return;
    console.log('[docreview] closing comments pane');
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    var closeBtn = panel ? panel.querySelector('[aria-label="Close"]') : null;
    if (closeBtn) fullClick(closeBtn);
  }

  // Find a comment listitem by disco ID. Returns { item, anchored } or null.
  // Prefers anchored entries (docos-anchoreddocoview) which have margin
  // highlights and don't need the comments pane. Non-anchored entries
  // (docos-streamdocoview) include resolved and unanchored comments.
  // The same ID can appear in both an anchored and non-anchored entry.
  function findCommentByDiscoId(discoId) {
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var nonAnchoredMatch = null;
    for (var i = 0; i < items.length; i++) {
      if (getDiscoId(items[i]) !== discoId) continue;
      if (items[i].classList.contains('docos-anchoreddocoview')) {
        return { item: items[i], anchored: true };
      }
      if (!nonAnchoredMatch) nonAnchoredMatch = items[i];
    }
    return nonAnchoredMatch ? { item: nonAnchoredMatch, anchored: false } : null;
  }

  // Wait for resolved comments to appear after opening the pane.
  function waitForResolvedComments() {
    return new Promise(function(resolve) {
      var attempts = 0;
      var check = setInterval(function() {
        var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
        for (var i = 0; i < items.length; i++) {
          if (items[i].textContent.indexOf('Resolved') !== -1) {
            clearInterval(check);
            resolve();
            return;
          }
        }
        if (++attempts > 25) { clearInterval(check); resolve(); }
      }, 200);
    });
  }

  window.__docreviewDisco = {
    getDiscoId: getDiscoId,
    listComments: listComments,
    getSuggestions: getSuggestions,
    getActiveCommentId: getActiveCommentId,
    fullClick: fullClick,
    isCommentsPaneOpen: isCommentsPaneOpen,
    openCommentsPane: openCommentsPane,
    closeCommentsPane: closeCommentsPane,
    findCommentByDiscoId: findCommentByDiscoId,
    waitForResolvedComments: waitForResolvedComments
  };
  // Expose debugging functions directly on window for convenience
  window.listComments = listComments;
  window.getSuggestions = getSuggestions;
  window.getActiveCommentId = getActiveCommentId;

  // Track comment selection/deselection across all #docos-stream-view elements.
  // Google Docs has two with the same id: the anchored sidebar and the
  // comments pane (added when "Show all comments" is opened). Sheets and
  // Slides may have different structures.
  var currentActiveEl = null;
  var trackedStreams = new WeakSet();

  // Query the DOM for the currently active comment and log changes.
  // Called on every mutation in a tracked stream view. Uses a global
  // querySelector (not scoped to one stream) so it works regardless of
  // which stream view contains the active comment.
  // Posts a window message so the content script can relay selection
  // changes to the background worker for cross-tab sync.
  function checkActive() {
    var active = document.querySelector('#docos-stream-view [role="listitem"].docos-docoview-active');
    if (active && active !== currentActiveEl) {
      currentActiveEl = active;
      var id = getDiscoId(active);
      console.log('[docreview] comment selected:', id || '(no ID)');
      window.postMessage({ source: 'docreview-comment-selection', selected: true, discoId: id || null }, '*');
    } else if (!active && currentActiveEl) {
      currentActiveEl = null;
      console.log('[docreview] comment deselected');
      window.postMessage({ source: 'docreview-comment-selection', selected: false, discoId: null }, '*');
    }
  }

  // Attach a MutationObserver to a #docos-stream-view element so that
  // class changes (comment selected/deselected) and child additions
  // (resolved comments appearing with active class already set) both
  // trigger checkActive(). Uses a WeakSet to avoid double-observing
  // the same element if trackStream is called multiple times.
  function trackStream(stream) {
    if (trackedStreams.has(stream)) return;
    trackedStreams.add(stream);
    new MutationObserver(function() {
      checkActive();
    }).observe(stream, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  }

  // Scan for #docos-stream-view elements and attach observers to any
  // new ones. Uses a lightweight interval instead of a document.body
  // MutationObserver to avoid firing on every DOM mutation (typing,
  // selections, etc.). Polls frequently at startup (250ms for 5s) to
  // catch stream views as soon as they appear, then slows to 5s for
  // the comments pane which can be opened at any time.
  function scanForStreams() {
    document.querySelectorAll('#docos-stream-view').forEach(trackStream);
  }
  scanForStreams();
  var scanInterval = setInterval(scanForStreams, 250);
  setTimeout(function() {
    clearInterval(scanInterval);
    setInterval(scanForStreams, 5000);
  }, 5000);
}

// Injected into a Google Docs tab to select a comment by disco ID without
// focusing the tab. Used when the user clicks a comment thread in the
// Docreview comments page. Like navigateToCommentInPage but without tab
// focusing or fallback URL — just selects the comment and manages the
// comments pane (close for anchored, open for non-anchored/resolved).
// Requires injectDiscoIdHelpers to have been injected first.
function selectCommentInPage(discoId) {
  var disco = window.__docreviewDisco;
  if (!disco) return;

  return (async function() {
    if (!discoId) return;

    var match = disco.findCommentByDiscoId(discoId);
    if (!match) {
      console.log('[docreview] comment not in stream view, opening pane');
      await disco.openCommentsPane();
      await disco.waitForResolvedComments();
      match = disco.findCommentByDiscoId(discoId);
    }
    if (!match) {
      console.log('[docreview] comment not found for selection:', discoId);
      return;
    }

    console.log('[docreview] selecting comment from docreview:', discoId, match.anchored ? '(anchored)' : '(non-anchored)');
    match.item.click();

    // Wait for DOM to settle (clicking can switch document tabs, rebuilding DOM)
    await new Promise(function(r) { setTimeout(r, 300); });
    var final = disco.findCommentByDiscoId(discoId);
    if (final) {
      final.item.click();
      if (final.anchored) {
        disco.closeCommentsPane();
      } else {
        await disco.openCommentsPane();
      }
    }
  })();
}

// Injected into Google Docs to extract the disco ID from the listitem marked
// with [data-docreview-extract] by the content script. Requires
// injectDiscoIdHelpers to have been injected first.
function extractCommentIdFromPage() {
  var disco = window.__docreviewDisco;
  if (!disco) return null;

  var marked = document.querySelector('[data-docreview-extract]');
  if (!marked) return null;
  marked.removeAttribute('data-docreview-extract');

  // Walk up to the [role="listitem"] ancestor
  var item = marked;
  while (item && item.getAttribute('role') !== 'listitem') {
    item = item.parentElement;
  }
  if (!item) return null;

  var id = disco.getDiscoId(item);
  if (id) return id;

  // For newly added elements, Closure Library may not have attached its
  // internals yet. Retry briefly — executeScript handles returned Promises.
  return new Promise(function(resolve) {
    var attempts = 0;
    var check = setInterval(function() {
      var id = disco.getDiscoId(item);
      if (id || ++attempts >= 10) {
        clearInterval(check);
        if (id) {
          console.log('[docreview-extract] got ID after ' + (attempts * 100) + 'ms:', id);
        } else {
          console.log('[docreview-extract] gave up after ' + (attempts * 100) + 'ms');
        }
        resolve(id);
      }
    }, 100);
  });
}

// The script injected into Google Docs to navigate to a comment by disco ID.
// Injected into the page's JS context via chrome.scripting.executeScript.
// Requires injectDiscoIdHelpers to have been injected first (provides the
// shared helpers on window.__docreviewDisco: findCommentByDiscoId,
// openCommentsPane, closeCommentsPane, waitForResolvedComments).
//
// Navigation flow:
//   1. Find the comment listitem by disco ID in the stream view
//   2. If not found, open the comments pane (loads resolved/unanchored) and retry
//   3. If still not found, fall back to page reload with ?disco= URL
//   4. Click the item to navigate (may trigger a document tab switch)
//   5. Wait 300ms for DOM to settle after potential tab switch
//   6. Re-find and click again to ensure selection with fresh DOM
//   7. Set pane state: close for anchored comments, open for non-anchored
//
// Key complications:
//   - Clicking a comment can switch document tabs, rebuilding the entire DOM
//     (hence the 300ms wait + re-find + second click)
//   - Pane state is determined from the doc, not from Docreview's resolved flag
//   - Resolved/unanchored comments only load when the comments pane is opened
function navigateToCommentInPage(discoId, _resolvedHint, fallbackUrl) {
  var disco = window.__docreviewDisco;
  if (!disco) return { success: false, error: 'disco helpers not loaded' };

  // --- Main navigation logic ---

  return (async function() {
    if (!discoId) return { success: true };

    // Step 1-2: Find the comment, opening pane if needed to load more
    var match = disco.findCommentByDiscoId(discoId);
    if (!match) {
      console.log('[docreview-nav] not in stream view, opening pane to load more');
      await disco.openCommentsPane();
      await disco.waitForResolvedComments();
      match = disco.findCommentByDiscoId(discoId);
    }
    if (!match) {
      console.log('[docreview-nav] comment not found:', discoId);
      if (fallbackUrl) {
        location.href = fallbackUrl;
        return { success: true, fallback: true };
      }
      return { success: false, error: 'comment not found' };
    }

    // Step 4: Click to navigate (may switch document tabs)
    console.log('[docreview-nav] navigating to:', discoId, match.anchored ? '(anchored)' : '(non-anchored)');
    match.item.click();

    // Steps 5-7: Wait for DOM to settle, re-find and click for reliable
    // selection, then set pane state based on final anchored/non-anchored.
    await new Promise(function(r) { setTimeout(r, 300); });
    var final = disco.findCommentByDiscoId(discoId);
    if (final) {
      final.item.click();
      if (final.anchored) {
        disco.closeCommentsPane();
      } else {
        await disco.openCommentsPane();
      }
      console.log('[docreview-nav] done:', final.anchored ? 'anchored' : 'non-anchored');
    } else {
      console.log('[docreview-nav] re-find failed after DOM settle, first click may have navigated');
    }
    return { success: true };
  })();
}

// Detect whether a Google Docs tab is showing a diff/version history view.
// Both the "Changes since..." view and the full version history view use
// .docs-revisions-chromecover-content as the diff overlay. The element persists
// in the DOM after closing the diff view but becomes hidden (zero size, null
// offsetParent), so we check visibility via offsetParent.
function isDiffViewFunc() {
  var el = document.querySelector('.docs-revisions-chromecover-content');
  return !!(el && el.offsetParent !== null);
}

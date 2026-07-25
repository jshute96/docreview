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
// Idempotent — skips if the installed helpers are already at this version.
//
// Version it, don't just check for existence: a Google Docs tab that was open
// when the extension reloaded keeps whatever object the *previous* build put on
// its window. A bare `if (window.__docreviewDisco) return` would preserve that
// stale object forever, so every method added by a newer build would be missing
// at all of this file's injection sites until the user reloaded the tab.
//
// Bump VERSION whenever the shape of window.__docreviewDisco changes (methods
// added, renamed, or given a different signature) or when the behavior of a
// helper installed here changes in a way already-open tabs shouldn't keep the
// old version of — the early return below means an unbumped fix never reaches
// them. "Installed here" covers the window.* console helpers too, not just
// __docreviewDisco: they're assigned below the same early return.
function injectDiscoIdHelpers() {
  var VERSION = 3;
  if (window.__docreviewDisco) {
    // `>=`, not `===`: with two builds loaded at once (an unpacked dev build
    // alongside a packed one — a normal dev setup) a strict check makes each
    // build tear the other down and reinstall on every single MAIN-world call,
    // thrashing the observers and resetting the cached disco path. Yielding to
    // an equal-or-newer install keeps whichever is furthest ahead.
    //
    // Trade-off: this makes downgrades impossible in-place. Rolling the
    // extension back leaves already-open tabs on the newer helpers until they
    // are reloaded. That's the right default — a tab is far more likely to be
    // holding a *stale* build than a future one.
    if (window.__docreviewDisco.version >= VERSION) return;
    // A newer build is replacing an older one. Stop the old build's timers and
    // observers first, or they keep running alongside ours — duplicate
    // selection messages and a leaked polling interval.
    //
    // Builds before VERSION 2 have no teardown(), so upgrading from one leaves
    // a single orphaned scanner + observer set in tabs that were already open.
    // That's a one-time cost per tab, bounded and harmless (the observers are
    // idempotent and the interval is a 5s querySelectorAll); it clears on the
    // next tab reload.
    if (typeof window.__docreviewDisco.teardown === 'function') {
      try { window.__docreviewDisco.teardown(); } catch(e) {}
    }
  }

  // The disco ID for each comment listitem is stored in Google's Closure Library
  // component tree under minified property names (e.g., .Yd.Ai) that change when
  // Google releases new code. Instead of hardcoding these names, we discover the
  // path dynamically by walking the tree and looking for AAA[A-Z]-pattern strings
  // (the 4th char is a counter — older docs start with AAAA, newer with AAAB+).
  //
  // Discovery strategy:
  //   - With 2+ items: diff two items' trees. Paths that exist in both but have
  //     different values are per-item IDs. Paths through array indices contain the
  //     shared model array (all IDs) — filter those out.
  //   - With 1 item: find the shortest path to an AAA[A-Z] string that doesn't traverse
  //     an array index. The shared array goes through numeric indices; the per-item
  //     ID is at a short, direct property path.
  //
  // The discovered path is cached across calls for the lifetime of the page.

  var discoveredIdPath = null;

  // Walk an object tree collecting paths to AAA[A-Z]-pattern strings.
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
          if (typeof v === 'string' && /^AAA[A-Z][A-Za-z0-9_-]{5,}$/.test(v) && v.length < 20) {
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
      return (typeof cur === 'string' && /^AAA[A-Z]/.test(cur)) ? cur : null;
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
      // Display-only placeholder — listComments() is a console debugging aid and
      // its output never leaves the page. Data paths must drop ID-less items
      // instead (see iterateItems).
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
  // Optional targetId: when provided, only parses the suggestion with that
  // disco ID (skips text/reply extraction for all others). Used by the
  // per-suggestion refresh path to avoid unnecessary DOM work.
  //
  // When the comments pane is open, the same suggestion appears in both the
  // anchored sidebar (docos-anchoreddocoview) and the pane (docos-streamdocoview).
  // We deduplicate by disco ID, preferring the anchored version for open
  // suggestions (richer DOM) and the stream version for resolved ones (only
  // place they appear).
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

  // Get the logged-in user's display name from the Google Account button
  // (e.g., "Google Account: Dave (docreview.dave@gmail.com)").
  function getMyName() {
    var accountBtn = document.querySelector('[aria-label*="Google Account"]');
    if (accountBtn) {
      var nameMatch = (accountBtn.getAttribute('aria-label') || '').match(/Google Account:\s*([^(]+)\s*\(/);
      if (nameMatch) return nameMatch[1].trim();
    }
    return '';
  }

  // Extract tab name from stream view header elements.
  // Only exists in stream view items (docos-streamdocoview), not in
  // anchored sidebar items (docos-anchoreddocoview).
  // Google renders JS null as literal "null" text — filter that out.
  function getTabName(item) {
    var header = item.querySelector('.docos-streamdocoview-header-container');
    if (!header) return undefined;
    var prefixEl = header.querySelector('.streamdocoview-header-prefix-location');
    var tabName = prefixEl ? prefixEl.textContent.trim() : '';
    if (tabName === 'null') tabName = '';
    return tabName || undefined;
  }

  // Shared parsing for both comments and suggestions: extract author, timestamp,
  // replies, originalContentDeleted, and tabName from a listitem element.
  // actionPatterns maps reply text prefixes to action names (e.g., 'Suggestion accepted' → 'accept').
  function parseItemCommon(item, label, isAnchored, prevTabName, myName, actionPatterns) {
    // Author and timestamp from the first entry.
    // Anchored view uses .docos-replyview-first; stream view may not have that
    // class, so fall back to the content container and aria-label.
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
      if (!author) {
        var authorMatch = label.match(/Author ([^.]+)\./);
        if (authorMatch) author = authorMatch[1];
      }
    }

    // Replies (all docos-replyview entries after the first one)
    var replyEntries = item.querySelectorAll('.docos-replyview');
    var replies = [];
    for (var r = 0; r < replyEntries.length; r++) {
      if (replyEntries[r].classList.contains('docos-replyview-first')) continue;
      var rBody = getReplyBody(replyEntries[r]);
      if (!rBody.text) continue;
      var rAuthor = getReplyAuthor(replyEntries[r]);
      var rAction = undefined;
      for (var pat in actionPatterns) {
        if (rBody.text.indexOf(pat) === 0) { rAction = actionPatterns[pat]; break; }
      }
      replies.push({
        author: rAuthor,
        isMine: !!(myName && rAuthor === myName),
        timestamp: getReplyTimestamp(replyEntries[r]),
        text: rAction ? '' : rBody.text,
        html: !rAction && rBody.html !== rBody.text ? rBody.html : undefined,
        action: rAction
      });
    }

    var originalContentDeleted = (label.toLowerCase().indexOf('original content is deleted') !== -1);
    var tabName = isAnchored ? prevTabName : (getTabName(item) || prevTabName);

    return {
      firstEntry: firstEntry,
      author: author,
      isMine: !!(myName && author === myName),
      timestamp: timestamp,
      replies: replies,
      originalContentDeleted: originalContentDeleted,
      tabName: tabName
    };
  }

  // Iterate #docos-stream-view listitems, deduplicate by disco ID, and call
  // parseFn for each unique item. Anchored items (richer DOM) are preferred
  // over stream items; stream items contribute tabName (only source).
  // parseFn(item, label, common) should return the entry to store, or null to skip.
  //
  // Returns { entries, missing }. Items whose disco ID can't be extracted are
  // dropped and counted in `missing` — never given a placeholder ID. The disco
  // ID is the only key we have for matching an item to its database row, to a
  // Gmail notification, or back to the DOM for navigation, so a synthetic value
  // would poison every one of those lookups. Callers should treat missing > 0
  // as an incomplete scrape and retry (see fetchCommentsAndSuggestions).
  //
  // `missing` counts DOM nodes, not distinct comments, and it drives the retry
  // decision — so be aware of two ways it can overstate the problem:
  //   - A single item appears in both the anchored and stream views. If only one
  //     copy yields an ID, the entry is fully captured yet still counted missing,
  //     so the caller retries work that already succeeded. Bounded (the retry
  //     budget caps it), but it means a doc with a persistently un-extractable
  //     duplicate view never reports a complete scrape.
  //   - Drops are counted before the `targetId` filter, so `missing` is only
  //     meaningful when `targetId` is undefined. Single-item lookups go through
  //     the array wrappers, which discard the count.
  // Deduplicating properly would need the very ID we failed to extract, so this
  // is accepted rather than fixed.
  function iterateItems(filterLabel, targetId, parseFn) {
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var byId = {};
    var missing = 0;
    var myName = getMyName();

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var label = item.getAttribute('aria-label') || '';
      if (!filterLabel(label)) continue;

      var id = getDiscoId(item);
      if (!id) { missing++; continue; }
      if (targetId && id !== targetId) continue;

      // Deduplicate: prefer anchored entries (richer DOM) over stream entries,
      // but always merge tabName from stream items (only source for tab name).
      var isAnchored = item.classList.contains('docos-anchoreddocoview');
      if (byId[id] && !isAnchored) {
        byId[id].tabName = byId[id].tabName || getTabName(item);
        continue;
      }

      var prevTabName = byId[id] ? byId[id].tabName : undefined;
      var entry = parseFn(item, label, isAnchored, prevTabName, myName);
      if (entry) {
        entry.id = id;
        byId[id] = entry;
      }
    }
    return { entries: Object.values(byId), missing: missing };
  }

  var suggestionActions = { 'Suggestion accepted': 'accept', 'Suggestion rejected': 'reject' };
  var commentActions = { 'Marked as resolved': 'resolve', 'Re-opened': 'reopen' };

  function getSuggestionsRaw(targetId) {
    return iterateItems(
      function(label) { return label.indexOf('Suggestions') === 0; },
      targetId,
      function(item, label, isAnchored, prevTabName, myName) {
        // Parse suggestion type and old/new text from styled description spans.
        var descDiv = item.querySelector('.docos-replyview-body div[style*="font-size:13px"]');
        var suggestionType = '', oldText = '', newText = '', description = '';
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
          } else if (suggestionType) {
            description = descDiv.textContent.trim();
          }
        }

        // Status: open, accepted, or rejected.
        var status = 'open';
        if (item.classList.contains('docos-docoview-resolved') ||
            !item.querySelector('[aria-label="Accept suggestion"]')) {
          var innerText = item.innerText || '';
          if (innerText.indexOf('Suggestion accepted') !== -1) status = 'accepted';
          else if (innerText.indexOf('Suggestion rejected') !== -1) status = 'rejected';
        }

        var common = parseItemCommon(item, label, isAnchored, prevTabName, myName, suggestionActions);
        return {
          suggestionType: suggestionType,
          status: status,
          oldText: oldText,
          newText: newText,
          description: description,
          author: common.author,
          isMine: common.isMine,
          timestamp: common.timestamp,
          replies: common.replies,
          originalContentDeleted: common.originalContentDeleted,
          tabName: common.tabName
        };
      }
    );
  }

  function getCommentsRaw(targetId) {
    return iterateItems(
      function(label) { return label.indexOf('Suggestions') !== 0; },
      targetId,
      function(item, label, isAnchored, prevTabName, myName) {
        var status = item.classList.contains('docos-docoview-resolved') ? 'resolved' : 'open';

        var common = parseItemCommon(item, label, isAnchored, prevTabName, myName, commentActions);

        // Comment body text from the first entry
        var text = '', html = '';
        if (common.firstEntry) {
          var bodyResult = getReplyBody(common.firstEntry);
          text = bodyResult.text;
          html = bodyResult.html;
        }

        return {
          status: status,
          author: common.author,
          isMine: common.isMine,
          timestamp: common.timestamp,
          text: text,
          html: html !== text ? html : undefined,
          replies: common.replies,
          originalContentDeleted: common.originalContentDeleted,
          tabName: common.tabName
        };
      }
    );
  }

  // Public array-returning wrappers — the debugging entry points and the
  // singular getComment()/getSuggestion() helpers all want a plain list.
  function getSuggestions(targetId) { return getSuggestionsRaw(targetId).entries; }
  function getComments(targetId) { return getCommentsRaw(targetId).entries; }

  // Combined fetch: full suggestions + minimal comment info.
  // Used by the Docreview page to get both in a single round-trip.
  // `missingIdCount` counts listitems whose disco ID couldn't be extracted and
  // were therefore dropped — a non-zero value means this scrape is incomplete.
  // It sums comments and suggestions: the two label filters are mutually
  // exclusive so nothing is double-counted across them, and a comment-side miss
  // is still evidence the pane isn't wired up yet, which implicates suggestions
  // too — so it gates the whole scrape, not just the half it came from.
  function getCommentsAndSuggestions() {
    var suggestions = getSuggestionsRaw();
    var fullComments = getCommentsRaw();
    // Strip comments down to just the fields the web app needs
    var comments = [];
    for (var i = 0; i < fullComments.entries.length; i++) {
      var c = fullComments.entries[i];
      comments.push({
        id: c.id,
        originalContentDeleted: c.originalContentDeleted,
        tabName: c.tabName
      });
    }
    return {
      suggestions: suggestions.entries,
      comments: comments,
      missingIdCount: suggestions.missing + fullComments.missing
    };
  }

  // Async wrapper around getCommentsAndSuggestions that retries while any item
  // is missing its disco ID.
  //
  // ID extraction walks Google's minified Closure listener objects, and the
  // property path is discovered by diffing two listitems. Neither is available
  // until the pane has finished wiring up its click handlers, so a scrape run
  // too early can yield items we can't identify. That's transient: a short
  // wait and a re-scrape recovers them within the same round-trip. Anything
  // still missing after the last attempt is reported via `missingIdCount` so
  // the caller can treat the result as partial and try again later.
  //
  // `deadline` (ms timestamp, optional) bounds the retries. The caller's bridge
  // message has its own timeout, and loadAllComments() may already have spent
  // most of it, so retrying blindly can push the whole round-trip past that
  // limit — which would turn a partial result into no result at all. When
  // there's no budget left for another wait, return what we have.
  var SCRAPE_MAX_ATTEMPTS = 3;
  var SCRAPE_RETRY_DELAY_MS = 200;
  function fetchCommentsAndSuggestions(deadline) {
    var attempt = 1;
    function tryOnce() {
      var data = getCommentsAndSuggestions();
      if (!data.missingIdCount) return Promise.resolve(data);
      var outOfTime = deadline && (Date.now() + SCRAPE_RETRY_DELAY_MS) >= deadline;
      if (attempt >= SCRAPE_MAX_ATTEMPTS || outOfTime) {
        console.warn('[docreview] getCommentsAndSuggestions: ' + data.missingIdCount +
          ' item(s) still missing disco IDs after ' + attempt + ' attempt(s)' +
          (outOfTime ? ' (out of time)' : '') + ' — returning partial result');
        return Promise.resolve(data);
      }
      attempt++;
      console.log('[docreview] getCommentsAndSuggestions: ' + data.missingIdCount +
        ' item(s) missing disco IDs — retrying (attempt ' + attempt + ' of ' + SCRAPE_MAX_ATTEMPTS + ')');
      return new Promise(function(resolve) {
        setTimeout(resolve, SCRAPE_RETRY_DELAY_MS);
      }).then(tryOnce);
    }
    return tryOnce();
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
    if (!btn) {
      console.log('[docreview] openCommentsPane: "Show all comments" button not found (activity sidebar present:',
        !!document.querySelector('.docs-docos-activity-sidebar') + ')');
      return Promise.resolve();
    }
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
    // A missing ID matches nothing. Defensive: every current caller pre-checks.
    // Specifically an *explicit* null — getDiscoId() returns null for an item whose
    // ID couldn't be extracted, and the `!==` below would compare it equal to a null
    // discoId, returning an arbitrary unidentified item as a "match". (undefined and
    // '' already mismatched, since getDiscoId() only ever returns a string or null.)
    if (!discoId) return null;
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
  // Optional deadline (ms timestamp); defaults to 5s from now.
  function waitForResolvedComments(deadline) {
    var maxTime = deadline || (Date.now() + 5000);
    return new Promise(function(resolve) {
      var check = setInterval(function() {
        var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
        for (var i = 0; i < items.length; i++) {
          if (items[i].textContent.indexOf('Resolved') !== -1) {
            clearInterval(check);
            resolve();
            return;
          }
        }
        if (Date.now() >= maxTime) { clearInterval(check); resolve(); }
      }, 200);
    });
  }

  // Ensure both comment lists are loaded (anchored + stream/resolved).
  // Called by background.js message handlers before fetching comments/suggestions,
  // and also available from the console for debugging: loadAllComments()
  // Returns a promise that resolves when both lists are available (5s timeout).
  // Concurrent calls share a single in-flight load (promise dedup).
  //
  // Logic:
  //   - Waits for the stream view container if page is still loading
  //   - If a previous call settled successfully and the items are still in the
  //     DOM, returns immediately (short-circuit)
  //   - Otherwise: opens the pane if closed, waits for the pane's stream view
  //     to stop mutating for SETTLE_MS, then closes the pane if we opened it
  //   - The settle wait is critical: Google populates the pane incrementally,
  //     so checking "any item exists" resolves too early and we'd close the
  //     pane before the full list is loaded
  var _loadAllPromise = null;
  // Set to true after a successful settle. Gates the short-circuit so that
  // leftover partial state from a timed-out previous call cannot masquerade
  // as a complete load — we only trust DOM state we actually observed settle.
  var _loadedSuccessfully = false;
  function loadAllComments() {
    if (_loadAllPromise) return _loadAllPromise;
    _loadAllPromise = _loadAllCommentsImpl().finally(function() { _loadAllPromise = null; });
    return _loadAllPromise;
  }
  function _loadAllCommentsImpl() {
    var TIMEOUT = 5000;
    // Wait this long with no relevant mutations before declaring an element
    // to have stopped changing. Matches setupDocReadyDetection's debounce.
    var SETTLE_MS = 250;
    var deadline = Date.now() + TIMEOUT;

    function remaining() { return Math.max(0, deadline - Date.now()); }

    function streamViewExists() {
      return !!document.querySelector('#docos-stream-view');
    }

    function hasStreamItems() {
      return !!document.querySelector('#docos-stream-view .docos-streamdocoview[role="listitem"]');
    }

    // True when the comments pane is showing its empty-state UI, meaning the
    // doc has zero comments of any kind. Docs with only resolved comments
    // do NOT trigger this — their resolved comments render as
    // .docos-streamdocoview listitems when the pane is opened and show up
    // via hasStreamItems instead. So this is a reliable "nothing to load"
    // signal; it does not misfire on the "anchored sidebar is empty, but
    // resolved comments exist" case. Only exists after the pane has been
    // opened at least once — not in the initial page DOM. Together,
    // hasStreamItems || hasZeroState means "the pane has finished loading,
    // we know its contents".
    function hasZeroState() {
      return !!document.querySelector('.docos-streampane-zero-state');
    }

    // The comments pane is inside .docs-docos-activity-sidebar and contains
    // its own #docos-stream-view (distinct from the anchored sidebar's). We
    // observe this specific stream view for settle — watching the anchored
    // one would pick up unrelated mutations.
    function getPaneStreamView() {
      var panel = document.querySelector('.docs-docos-activity-sidebar');
      return panel ? panel.querySelector('#docos-stream-view') : null;
    }

    // Wait for an element matching `selector` to exist, bounded by the
    // overall deadline. Resolves true on found, false on timeout.
    function waitForSelector(selector) {
      return new Promise(function(resolve) {
        if (document.querySelector(selector)) { resolve(true); return; }
        var timeLeft = remaining();
        if (timeLeft <= 0) { resolve(false); return; }
        var hardTimer = null;
        var observer = new MutationObserver(function() {
          if (document.querySelector(selector)) {
            observer.disconnect();
            clearTimeout(hardTimer);
            resolve(true);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        hardTimer = setTimeout(function() {
          observer.disconnect();
          resolve(false);
        }, timeLeft);
      });
    }

    // Wait for the pane's stream view to stop mutating for SETTLE_MS.
    // Resolves true on settle, false on overall timeout.
    async function waitForPaneSettle() {
      // openCommentsPane resolves as soon as the sidebar is visible
      // (offsetParent !== null), but Google's Closure code may not have
      // constructed the pane's inner #docos-stream-view yet. Wait for that
      // element to exist before observing — otherwise a null target would
      // resolve false immediately and we'd report a spurious timeout on
      // exactly the first-call cold-start we're trying to fix.
      if (!(await waitForSelector('.docs-docos-activity-sidebar #docos-stream-view'))) {
        return false;
      }
      var target = getPaneStreamView();
      if (!target) return false; // belt-and-suspenders: selector matched, lookup should too

      return new Promise(function(resolve) {
        var settleTimer = null;
        var hardTimer = null;
        var observer = new MutationObserver(function() {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(onSettled, SETTLE_MS);
        });
        function cleanup() {
          observer.disconnect();
          if (settleTimer) clearTimeout(settleTimer);
          if (hardTimer) clearTimeout(hardTimer);
        }
        function onSettled() { cleanup(); resolve(true); }
        function onTimeout() { cleanup(); resolve(false); }

        observer.observe(target, { childList: true, subtree: true });
        // Start the debounce optimistically — if no mutations arrive, the
        // DOM is already stable and we'll resolve after SETTLE_MS.
        settleTimer = setTimeout(onSettled, SETTLE_MS);
        // Hard cap so we never wait past the overall deadline. Note: if
        // remaining() < SETTLE_MS when we get here, the hard timer fires
        // before the debounce settle — we report timeout even if the DOM
        // is quiet. That's acceptable; it only happens when we've nearly
        // exhausted the 5s budget already.
        var timeLeft = remaining();
        if (timeLeft > 0) hardTimer = setTimeout(onTimeout, timeLeft);
        else onTimeout();
      });
    }

    return (async function() {
      console.log('[docreview] loadAllComments: starting');

      // Phase 1: Wait for Google Docs to create the stream view container
      // (may not exist yet if page is still loading). View-only docs never
      // get one, so we time out on them — acceptable since they have no
      // comments to scrape anyway.
      if (!streamViewExists()) {
        console.log('[docreview] loadAllComments: waiting for stream view');
        if (!(await waitForSelector('#docos-stream-view'))) {
          console.log('[docreview] loadAllComments: stream view did not appear (view-only or slow-loading doc)');
          return;
        }
      }

      // Phase 2: If a previous call settled successfully and the DOM still
      // reflects that state, skip reopening the pane.
      // Why _loadedSuccessfully gate: without it, a previous call that timed
      // out mid-load would leave a partial set of stream items in the DOM,
      // and this check would incorrectly short-circuit subsequent calls —
      // causing getComments() to return the partial list indefinitely.
      if (_loadedSuccessfully && (hasStreamItems() || hasZeroState())) {
        console.log('[docreview] loadAllComments: already loaded (cached settled state)');
        return;
      }

      // Phase 3: Open the pane if closed; then wait for the list to finish
      // populating before returning. Google populates items incrementally,
      // so "any item exists" is not a reliable done signal — we wait for
      // mutations to settle.
      var wasOpen = isCommentsPaneOpen();
      if (!wasOpen) {
        // The "Show all comments" toolbar button can lag behind the stream
        // view during slow page loads. Wait for it before clicking so
        // openCommentsPane isn't a silent no-op.
        if (!(await waitForSelector('[aria-label*="Show all comments"]'))) {
          console.log('[docreview] loadAllComments: "Show all comments" button did not appear');
          return;
        }
        // Same reasoning as the close below — an orphaned load must not drive
        // the pane once a newer build has taken over.
        if (tornDown) return;
        console.log('[docreview] loadAllComments: opening comments pane');
        await openCommentsPane();
      } else {
        console.log('[docreview] loadAllComments: pane already open, waiting for items to settle');
      }

      var settled = await waitForPaneSettle();
      if (settled) _loadedSuccessfully = true;

      // Don't touch the pane if a newer build has taken over — this load is
      // orphaned, and closing the pane now would yank it out from under
      // whatever scrape the new build is running.
      if (!wasOpen && !tornDown) {
        closeCommentsPane();
      }

      if (!settled) {
        console.log('[docreview] loadAllComments: timeout waiting for pane to settle');
        return;
      }

      var itemCount = document.querySelectorAll('#docos-stream-view [role="listitem"]').length;
      console.log('[docreview] loadAllComments: done (' + itemCount + ' listitem(s))' +
        (wasOpen ? ' (pane left open)' : ' (pane closed)'));
    })();
  }

  window.__docreviewDisco = {
    // Read by injectDiscoIdHelpers to decide whether this page's helpers are
    // stale and need replacing — see VERSION at the top of this function.
    version: VERSION,
    teardown: teardown,
    getDiscoId: getDiscoId,
    listComments: listComments,
    getComments: getComments,
    getSuggestions: getSuggestions,
    getCommentsAndSuggestions: getCommentsAndSuggestions,
    fetchCommentsAndSuggestions: fetchCommentsAndSuggestions,
    getActiveCommentId: getActiveCommentId,
    fullClick: fullClick,
    isCommentsPaneOpen: isCommentsPaneOpen,
    openCommentsPane: openCommentsPane,
    closeCommentsPane: closeCommentsPane,
    findCommentByDiscoId: findCommentByDiscoId,
    waitForResolvedComments: waitForResolvedComments,
    loadAllComments: loadAllComments
  };
  // Singular wrappers for debugging: return one item by disco ID, not an array.
  // The ID is required. Without it the plural helpers apply no filter and return
  // everything, so taking [0] would hand back an arbitrary item that looks like a
  // match but isn't — call getComments()/getSuggestions() to list all instead.
  function missingDiscoId(name, listAllName, id) {
    if (id) return false;
    console.warn('[docreview] ' + name + '(discoId) requires a disco ID — ' +
      'call ' + listAllName + '() to list all items');
    return true;
  }
  function getComment(id) {
    if (missingDiscoId('getComment', 'getComments', id)) return null;
    return getComments(id)[0] || null;
  }
  function getSuggestion(id) {
    if (missingDiscoId('getSuggestion', 'getSuggestions', id)) return null;
    return getSuggestions(id)[0] || null;
  }

  // Expose debugging functions directly on window for convenience.
  // All are synchronous — they return data from the current DOM state.
  // Call loadAllComments() first to ensure resolved/unanchored items are loaded.
  window.listComments = listComments;
  window.getComments = getComments;
  window.getComment = getComment;
  window.getSuggestions = getSuggestions;
  window.getSuggestion = getSuggestion;
  window.getActiveCommentId = getActiveCommentId;

  // Async helper — fire-and-forget wrapper. loadAllComments logs its own start/phases.
  window.loadAllComments = function() {
    loadAllComments().catch(function(err) {
      console.warn('[docreview] loadAllComments error:', err);
    });
  };

  // Track comment selection/deselection across all #docos-stream-view elements.
  // Google Docs has two with the same id: the anchored sidebar and the
  // comments pane (added when "Show all comments" is opened). Sheets and
  // Slides may have different structures.
  var currentActiveEl = null;
  var trackedStreams = new WeakSet();
  // Registered so teardown() can stop them when a newer build re-injects.
  var observers = [];
  var timers = [];
  // Set by teardown() so any of this build's async work that is still in flight
  // knows to stop touching shared DOM — see the closeCommentsPane guard in
  // _loadAllCommentsImpl.
  var tornDown = false;

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
    var observer = new MutationObserver(function() {
      checkActive();
    });
    observer.observe(stream, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    observers.push(observer);
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
  timers.push(scanInterval);
  timers.push(setTimeout(function() {
    clearInterval(scanInterval);
    timers.push(setInterval(scanForStreams, 5000));
  }, 5000));

  // Stop this injection's long-lived work so a newer build can take over
  // without running in parallel with us: the stream-scanning intervals and the
  // selection MutationObservers, which otherwise run for the life of the page.
  //
  // Short-lived timers inside loadAllComments/waitForSelector/waitForPaneSettle
  // are deliberately not registered — each is self-bounded (≤5s) so nothing
  // leaks. The one that matters is an in-flight loadAllComments, which would
  // otherwise close the comments pane on completion; `tornDown` suppresses that.
  //
  // Timeouts and intervals share one ID space in browsers, so clearing both
  // covers either kind of handle. Safe to call twice — the arrays are emptied.
  function teardown() {
    tornDown = true;
    timers.forEach(function(t) { clearTimeout(t); clearInterval(t); });
    observers.forEach(function(o) { o.disconnect(); });
    timers = [];
    observers = [];
  }
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

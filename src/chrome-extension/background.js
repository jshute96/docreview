// Docreview Chrome Extension — Background Service Worker
//
// Handles toolbar icon clicks, context menu actions, and messages from content scripts.
// For Docs/Drive pages, the tab URL itself identifies the document.
// For Gmail, the doc URL must be extracted from the page at click time because:
//   - Gmail is a SPA; the tab URL is just mail.google.com/...
//   - Doc links live inside the message body, sometimes in sandboxed AMP iframes
//   - We use chrome.scripting.executeScript(allFrames: true) to reach into those
//     iframes, which content scripts can't access due to the sandbox origin being null
importScripts('defaults.js');

const SUPPORTED_HOSTS = [
  'docs.google.com',
  'drive.google.com',
  'mail.google.com'
];

function isSupportedUrl(url) {
  try {
    var host = new URL(url).hostname;
    return SUPPORTED_HOSTS.some(function(h) { return host.endsWith(h); });
  } catch (e) {
    return false;
  }
}

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

// Run findDocUrlsInFramesFunc across all frames in a tab, then merge results by doc ID.
async function findDocUrlsInTab(tabId) {
  var results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: findDocUrlsInFramesFunc
    });
  } catch (err) {
    console.warn('[background] Failed to execute script in tab', tabId, err);
    return [];
  }

  var seenIds = {};
  var urls = [];
  for (var i = 0; i < results.length; i++) {
    var frameUrls = results[i].result || [];
    for (var j = 0; j < frameUrls.length; j++) {
      var m = frameUrls[j].match(/\/d\/([a-zA-Z0-9_-]+)\//);
      var id = m ? m[1] : frameUrls[j];
      if (!seenIds[id]) { urls.push(frameUrls[j]); seenIds[id] = true; }
    }
  }
  return urls;
}

// Open a doc from a Gmail tab. If exactly one doc is found, open it in Docreview.
// If multiple distinct docs are found, alert the user rather than guessing.
async function openDocFromGmailTab(tabId) {
  var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
  var tab = await chrome.tabs.get(tabId);
  var docUrls = await findDocUrlsInTab(tabId);
  if (docUrls.length === 1) {
    chrome.tabs.create({ url: baseUrl + '/open?doc=' + encodeURIComponent(docUrls[0]), index: tab.index + 1 });
  } else if (docUrls.length > 1) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() { alert('Multiple document links found on this page'); }
    }).catch(function(err) {
      console.warn('[background] Failed to show alert on', tab.url, err);
    });
  } else {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() { alert('Page is not a document supported in Docreview'); }
    }).catch(function(err) {
      console.warn('[background] Failed to show alert on', tab.url, err);
    });
  }
}

// Toolbar icon click: open current doc in Docreview.
// For Docs (including Sheets/Slides), the tab URL contains the doc ID directly.
// For Gmail, delegate to openDocFromGmailTab which searches frame contents.
// Drive pages show file lists, not single documents, so the toolbar doesn't apply there.
chrome.action.onClicked.addListener(async function(tab) {
  if (!tab.url || !isSupportedUrl(tab.url)) {
    if (!tab.url || tab.url === 'chrome://newtab/' || tab.url === 'about:blank') {
      var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
      chrome.tabs.update(tab.id, { url: baseUrl });
    } else {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function() { alert('Page is not a document supported in Docreview'); }
      }).catch(function(err) {
        // Script injection fails on protected pages (chrome://, etc.)
        console.warn('[background] Failed to show alert on', tab.url, err);
      });
    }
    return;
  }

  var host = new URL(tab.url).hostname;
  if (host.endsWith('mail.google.com')) {
    await openDocFromGmailTab(tab.id);
    return;
  }

  // Only open in Docreview if the URL contains a document ID (Docs/Sheets/Slides).
  // Drive pages (drive.google.com/drive/...) don't identify a single document.
  if (!tab.url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\//)) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() { alert('Page is not a document supported in Docreview'); }
    }).catch(function(err) {
      console.warn('[background] Failed to show alert on', tab.url, err);
    });
    return;
  }

  // Track this tab so comment navigation can reuse it instead of opening a new one
  var docMatch = tab.url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    await setDocTab(docMatch[1], tab.id);
    setDocTabName(tab.id, docMatch[1]);
  }

  var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
  chrome.tabs.create({ url: baseUrl + '/open?doc=' + encodeURIComponent(tab.url), index: tab.index + 1 });
});

// --- Comment activity debounce ---
// When the content script detects comment activity on a Google Docs page,
// it sends a commentActivity message with { docId }. We use leading+trailing
// debounce: fire immediately on the first event, then suppress for 1s. If
// more events arrive during cooldown, fire once more when it expires — the
// trailing sync catches changes that the leading sync may have missed.
var commentActivityTimers = new Map(); // docId -> { timerId, pending }
var COMMENT_SYNC_COOLDOWN = 1000;

function fireCommentSync(docId) {
  chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl }, function(config) {
    var url = config.baseUrl + '/api/docs/sync-comments/' + docId;
    fetch(url, { method: 'POST', credentials: 'include' }).then(function(res) {
      if (res.ok) {
        console.log('[background] comment sync succeeded for', docId);
        // Notify open docreview tabs so they refresh
        chrome.tabs.query({ url: config.baseUrl + '/*' }, function(tabs) {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'commentSynced', docId: docId }, function() {
              if (chrome.runtime.lastError) {
                console.warn('[background] sendMessage failed:', chrome.runtime.lastError.message);
              }
            });
          } else {
            console.log('[background] no docreview tabs open, skipping notification');
          }
        });
      } else {
        console.warn('[background] comment sync failed for', docId, 'status:', res.status);
      }
    }).catch(function(err) {
      console.warn('[background] comment sync error for', docId, err);
    });
  });
}

// Handle messages from content scripts.
// - commentActivity: from Docs content script, syncs comments for a doc (debounced)
// - openDocInDocreview: from Gmail content script, opens doc in Docreview
// - trackDocTab: from Docs content script, tracks the tab for comment navigation reuse
// - ping: from docreview-bridge, returns extension status
// - resolveUrl: from docreview-bridge, follows redirects to resolve shortened URLs
// - focusDocTab: from docreview-bridge, focuses an existing Google Docs tab without creating one
// - navigateToComment: from docreview-bridge, navigates to a comment in an open Google Docs tab
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'commentActivity' && msg.docId) {
    var docId = msg.docId;
    var state = commentActivityTimers.get(docId);
    if (state) {
      // In cooldown — mark pending so trailing sync fires when cooldown expires
      state.pending = true;
      console.log('[background] commentActivity for', docId, '(cooldown active, trailing will fire)');
    } else {
      // No cooldown — fire immediately and start cooldown
      console.log('[background] commentActivity for', docId, '(firing immediately)');
      fireCommentSync(docId);
      var timerId = setTimeout(function() {
        var s = commentActivityTimers.get(docId);
        commentActivityTimers.delete(docId);
        // Only fire trailing sync if more events arrived during cooldown —
        // the leading sync may have missed their changes.
        if (s && s.pending) {
          console.log('[background] commentActivity for', docId, '(firing trailing after cooldown)');
          fireCommentSync(docId);
        }
      }, COMMENT_SYNC_COOLDOWN);
      commentActivityTimers.set(docId, { timerId: timerId, pending: false });
    }
    return;
  }

  if (msg.type === 'openDocInDocreview' && sender.tab) {
    openDocFromGmailTab(sender.tab.id);
    return;
  }

  if (msg.type === 'trackDocTab' && sender.tab) {
    chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs }, function(config) {
      if (!config.enableDocs) return;
      setDocTab(msg.docId, sender.tab.id);
      setDocTabName(sender.tab.id, msg.docId);
    });
    return;
  }

  if (msg.type === 'ping') {
    console.log('[background] ping received');
    chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl, enableDocs: DEFAULTS.enableDocs, enableResolve: DEFAULTS.enableResolve, resolveHosts: DEFAULTS.resolveHosts }, function(config) {
      sendResponse({ version: 2, baseUrl: config.baseUrl, enableDocs: config.enableDocs, enableResolve: config.enableResolve, resolveHosts: config.resolveHosts });
    });
    return true; // async response
  }

  if (msg.type === 'resolveUrl') {
    console.log('[background] resolveUrl:', msg.url);
    chrome.storage.sync.get({ enableResolve: DEFAULTS.enableResolve }, function(config) {
      if (!config.enableResolve) {
        sendResponse({ resolved: false, error: 'disabled' });
        return;
      }
      resolveUrlViaTab(msg.url, msg.pageId).then(function(result) {
        sendResponse(result);
      });
    });
    return true; // async response
  }

  if (msg.type === 'cancelResolve') {
    cancelResolveTabs(msg.pageId);
    return;
  }

  if (msg.type === 'focusDocTab') {
    // Try to focus an existing Google Docs tab for this doc. Returns { found: true }
    // if successful, { found: false } if no tab exists. Does NOT create a new tab.
    // Gated on enableDocs for consistency (caller also checks via supportsCommentNavigation).
    (async function() {
      var config = await chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs });
      if (!config.enableDocs) { sendResponse({ found: false }); return; }
      var tabId = await findDocTab(msg.docId);
      if (tabId) {
        await chrome.tabs.update(tabId, { active: true });
        var windowId = (await chrome.tabs.get(tabId)).windowId;
        await chrome.windows.update(windowId, { focused: true });
        setDocTabName(tabId, msg.docId);
        sendResponse({ found: true });
      } else {
        sendResponse({ found: false });
      }
    })();
    return true; // async response
  }

  if (msg.type === 'navigateToComment') {
    chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs }, function(config) {
      if (!config.enableDocs) {
        sendResponse({ success: false, error: 'Google Docs integration is disabled' });
        return;
      }
      navigateToComment(msg.docId, msg.discoId, msg.docUrl, msg.resolved, sender.tab).then(function(result) {
        console.log('[background] navigateToComment result:', result);
        sendResponse(result);
      }).catch(function(err) {
        console.error('[background] navigateToComment error:', err);
        sendResponse({ success: false, error: err.message });
      });
    });
    return true; // async response
  }
});

// --- In-page comment navigation ---
//
// Tracks Google Docs tabs opened by Docreview so we can navigate to comments
// without reloading the page. The first click opens the doc normally (with
// ?disco= for initial scroll); subsequent clicks inject a script that finds
// the comment in the Closure component tree and clicks it.

// docId -> tabId mapping for docs opened by Docreview.
// Persisted in chrome.storage.session so it survives service worker restarts
// (Manifest V3 service workers can be terminated between messages).

async function getDocTabs() {
  var data = await chrome.storage.session.get({ docTabs: {} });
  return data.docTabs || {};
}

async function setDocTab(docId, tabId) {
  var tabs = await getDocTabs();
  tabs[docId] = tabId;
  await chrome.storage.session.set({ docTabs: tabs });
}

async function removeDocTab(docId) {
  var tabs = await getDocTabs();
  delete tabs[docId];
  await chrome.storage.session.set({ docTabs: tabs });
}

// Find an existing Google Docs tab for the given doc ID.
// Checks docTabMap first, then searches open tabs by URL.
// Returns the tab ID if found (and updates docTabMap), or null.
async function findDocTab(docId) {
  var allTabs = await getDocTabs();
  var tabId = allTabs[docId] || null;

  // Verify tracked tab still exists and is on the right doc
  if (tabId) {
    try {
      var tab = await chrome.tabs.get(tabId);
      if (!tab || !tab.url || !tab.url.includes(docId)) {
        await removeDocTab(docId);
        tabId = null;
      }
    } catch(e) {
      await removeDocTab(docId);
      tabId = null;
    }
  }

  // Search by URL if not tracked
  if (!tabId) {
    try {
      var candidates = await chrome.tabs.query({ url: 'https://docs.google.com/*' });
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].url && candidates[i].url.includes('/d/' + docId + '/')) {
          tabId = candidates[i].id;
          await setDocTab(docId, tabId);
          console.log('[background] found existing doc tab by URL:', { docId, tabId });
          break;
        }
      }
    } catch (e) {
      // Query failed, fall through
    }
  }

  return tabId;
}

// Set window.name on a Google Docs tab so the web app's <a target="doc-{id}">
// can find it. No-op if window.name is already set.
function setDocTabName(tabId, docId) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function(name) { if (!window.name) window.name = name; },
    args: ['doc-' + docId]
  }).catch(function() {});
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener(async function(tabId) {
  var tabs = await getDocTabs();
  var changed = false;
  for (var docId in tabs) {
    if (tabs[docId] === tabId) {
      delete tabs[docId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.session.set({ docTabs: tabs });
});

// Clean up when a tracked tab navigates away from the doc
chrome.tabs.onUpdated.addListener(async function(tabId, changeInfo) {
  if (!changeInfo.url) return;
  var tabs = await getDocTabs();
  for (var docId in tabs) {
    if (tabs[docId] !== tabId) continue;
    // If the tab navigated to a different doc or a non-Docs page, remove tracking
    if (!changeInfo.url.includes(docId)) {
      delete tabs[docId];
      await chrome.storage.session.set({ docTabs: tabs });
    }
  }
});

// The script injected into Google Docs to navigate to a comment by disco ID.
// Runs in the MAIN world so it can access the Closure component tree.
// Arguments are passed via the args parameter of chrome.scripting.executeScript.
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
// Key complications this handles:
//   - Same disco ID can appear twice (anchored + stream entry); prefer anchored
//   - Clicking a comment can switch document tabs, rebuilding the entire DOM
//   - Resolved/unanchored comments only load when the comments pane is opened
//   - Pane state is determined from the doc, not from Docreview's resolved flag
//   - Google Docs buttons need full mousedown+mouseup+click (bare .click() ignored)
//   - Multiple [role="complementary"] elements; use .docs-docos-activity-sidebar
function navigateToCommentInPage(discoId, _resolvedHint, fallbackUrl) {

  // --- ID extraction from Closure component tree ---

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
  // The discovered path is used for all items within a single navigation call.
  // Since this function is injected fresh each time, there's no cross-call cache,
  // but discovery is fast (~3ms) and only runs once per invocation.

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
      // Differential: find non-array paths that have different values across two items
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
      // Single item: shortest non-array path to an AAAB string
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

  function getDiscoId(item) {
    // Try the cached path first
    if (discoveredIdPath) {
      var id = extractIdByPath(item, discoveredIdPath);
      if (id) return id;
    }

    // Cached path failed or doesn't exist — discover it
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var newPath = discoverIdPath(items);
    if (newPath) {
      discoveredIdPath = newPath;
      console.log('[docreview-nav] discovered ID path:', newPath.join('.'));
      var id = extractIdByPath(item, newPath);
      if (id) return id;
    }

    console.log('[docreview-nav] ID extraction failed');
    return null;
  }

  // --- DOM helpers ---

  // Google Docs buttons require a full mousedown+mouseup+click sequence;
  // a bare .click() is ignored by the Closure event system.
  function fullClick(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // --- Comments pane management ---
  // The pane has class docs-docos-activity-sidebar. There are multiple
  // [role="complementary"] elements on the page; must use the specific class.

  function isCommentsPaneOpen() {
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    return !!(panel && panel.offsetParent !== null);
  }

  function openCommentsPane() {
    if (isCommentsPaneOpen()) return Promise.resolve();
    console.log('[docreview-nav] opening comments pane');
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
    console.log('[docreview-nav] closing comments pane');
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    var closeBtn = panel ? panel.querySelector('[aria-label="Close"]') : null;
    if (closeBtn) fullClick(closeBtn);
  }

  // --- Comment finding ---

  // Find the comment listitem by disco ID. Returns { item, anchored } or null.
  // Prefers anchored entries (docos-anchoreddocoview) which have margin
  // highlights and don't need the comments pane. Non-anchored entries
  // (docos-streamdocoview) include resolved and unanchored comments.
  // The same ID can appear in both an anchored and non-anchored entry.
  function findItem() {
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
    var nonAnchoredMatch = null;
    for (var i = 0; i < items.length; i++) {
      var id = getDiscoId(items[i]);
      if (id !== discoId) continue;
      if (items[i].classList.contains('docos-anchoreddocoview')) {
        return { item: items[i], anchored: true };
      }
      if (!nonAnchoredMatch) nonAnchoredMatch = items[i];
    }
    return nonAnchoredMatch ? { item: nonAnchoredMatch, anchored: false } : null;
  }

  // Wait for resolved comments to appear after opening the pane
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

  // --- Main navigation logic ---

  return (async function() {
    if (!discoId) return { success: true };

    // Step 1-2: Find the comment, opening pane if needed to load more
    var match = findItem();
    if (!match) {
      console.log('[docreview-nav] not in stream view, opening pane to load more');
      await openCommentsPane();
      await waitForResolvedComments();
      match = findItem();
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
    var final = findItem();
    if (final) {
      final.item.click();
      if (final.anchored) {
        closeCommentsPane();
      } else {
        await openCommentsPane();
      }
      console.log('[docreview-nav] done:', final.anchored ? 'anchored' : 'non-anchored');
    } else {
      console.log('[docreview-nav] re-find failed after DOM settle, first click may have navigated');
    }
    return { success: true };
  })();
}

// Handle a navigateToComment request from the Docreview web app.
// If we have a tracked tab for this doc, inject the navigation script.
// Otherwise, open a new tab with the disco= URL.
async function navigateToComment(docId, discoId, docUrl, resolved, senderTab) {
  var tabId = await findDocTab(docId);
  console.log('[background] navigateToComment:', { docId, discoId, resolved, tabId });

  // Build the disco= fallback URL
  var fallbackUrl = docUrl;
  if (discoId) {
    var u = new URL(docUrl);
    u.searchParams.set('disco', discoId);
    fallbackUrl = u.toString();
  }

  if (!tabId) {
    // No existing tab — open a new one. Use disco= URL if we have an ID,
    // otherwise just open the doc at the top.
    console.log('[background] opening new tab:', { hasDisco: !!discoId });
    var newTabIndex = senderTab ? senderTab.index + 1 : undefined;
    var newTab = await chrome.tabs.create({ url: fallbackUrl, index: newTabIndex });
    await setDocTab(docId, newTab.id);
    // Set window.name so the web app's <a target="doc-{id}"> can find this tab.
    // Also set on subsequent interactions via focusDocTab and trackDocTab.
    setDocTabName(newTab.id, docId);
    console.log('[background] new tab opened, tracking:', { docId, tabId: newTab.id });
    return { success: true, opened: true };
  }

  // Focus the existing tab. The delay lets the tab fully render before we
  // inject — without it, Google Docs sometimes processes the click internally
  // (setting docos-docoview-active) without visually expanding the comment.
  // TODO: find a better signal than a fixed delay (e.g., tab 'activated' event)
  console.log('[background] focusing existing tab:', tabId);
  await chrome.tabs.update(tabId, { active: true });
  var windowId = (await chrome.tabs.get(tabId)).windowId;
  await chrome.windows.update(windowId, { focused: true });
  await new Promise(function(r) { setTimeout(r, 300); });

  // If no disco ID, just focus the tab
  if (!discoId) {
    console.log('[background] no discoId, focusing tab only');
    return { success: true, focused: true };
  }

  // Inject the navigation script
  console.log('[background] injecting navigation script for:', discoId);
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: navigateToCommentInPage,
      args: [discoId, !!resolved, fallbackUrl],
      world: 'MAIN'
    });
    var result = results && results[0] && results[0].result;
    return result || { success: false, error: 'no result from injected script' };
  } catch(err) {
    // Script injection failed — fall back to opening with disco= URL
    await chrome.tabs.update(tabId, { url: fallbackUrl });
    return { success: true, fallback: true };
  }
}

// Resolve a shortened URL by opening it in a background tab and watching
// for a redirect to a Google Docs/Drive URL. This works for shorteners that
// require browser authentication because the tab has access
// to the user's cookies.
function isGoogleDocUrl(url) {
  return /docs\.google\.com\/(document|spreadsheets|presentation)\/d\//.test(url) ||
    /drive\.google\.com\/file\/d\//.test(url) ||
    /drive\.google\.com\/.*[?&]id=/.test(url);
}

// Track in-flight resolve tabs so they can be cancelled.
// Keyed by tabId, each entry includes the pageId that requested it.
var pendingResolveTabs = new Map(); // tabId -> { pageId, timeout, listener, resolve }

function cancelResolveTabs(pageId) {
  pendingResolveTabs.forEach(function(pending, tabId) {
    if (pending.pageId !== pageId) return;
    clearTimeout(pending.timeout);
    chrome.tabs.onUpdated.removeListener(pending.listener);
    pendingResolveTabs.delete(tabId);
    try { chrome.tabs.remove(tabId); } catch (e) { /* tab may already be closed */ }
    pending.resolve({ resolved: false, error: 'cancelled' });
  });
}

function resolveUrlViaTab(url, pageId) {
  return new Promise(function(resolve) {
    chrome.tabs.create({ url: url, active: false }, function(tab) {
      var tabId = tab.id;

      function cleanup() {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        pendingResolveTabs.delete(tabId);
        try { chrome.tabs.remove(tabId); } catch (e) { /* tab may already be closed */ }
      }

      var timeout = setTimeout(function() {
        cleanup();
        resolve({ resolved: false, error: 'timeout' });
      }, 5000);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId) return;

        // changeInfo.url fires when the tab URL changes (including redirects)
        var newUrl = changeInfo.url;
        if (newUrl && isGoogleDocUrl(newUrl)) {
          cleanup();
          resolve({ resolved: true, url: newUrl });
          return;
        }

        // If the page finished loading and it's not a Google Doc, give up.
        // This handles errors (DNS failure, connection refused), pages that
        // aren't redirects, and redirects to non-Google destinations.
        if (changeInfo.status === 'complete') {
          chrome.tabs.get(tabId, function(t) {
            if (t && t.url && !isGoogleDocUrl(t.url)) {
              cleanup();
              resolve({ resolved: false });
            }
          });
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
      pendingResolveTabs.set(tabId, { pageId: pageId, timeout: timeout, listener: listener, resolve: resolve });
    });
  });
}

// Dynamically register the docreview-bridge content script for the configured
// baseUrl. This lets the web app detect the extension and send it messages
// (e.g. to resolve shortened URLs). Re-registers whenever baseUrl changes.
var BRIDGE_SCRIPT_ID = 'docreview-bridge';

async function registerBridgeScript() {
  var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
  var origin = baseUrl.replace(/\/+$/, '');
  var pattern = origin + '/*';

  // Unregister first (may not exist yet, ignore errors)
  try { await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] }); }
  catch (e) { /* not registered yet */ }

  try {
    await chrome.scripting.registerContentScripts([{
      id: BRIDGE_SCRIPT_ID,
      matches: [pattern],
      js: ['defaults.js', 'docreview-bridge.js'],
      runAt: 'document_start'
    }]);
  } catch (e) {
    console.error('[background] Failed to register bridge script for', pattern, e);
  }
}

// Re-register when settings change
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === 'sync' && changes.baseUrl) {
    registerBridgeScript();
  }
});

// Context menu items on the toolbar icon (right-click).
// Chrome automatically adds an "Options" item from the manifest's options_ui declaration.
chrome.runtime.onInstalled.addListener(function() {
  registerBridgeScript();
  chrome.contextMenus.create({
    id: 'open-docreview',
    title: 'Open Docreview',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'add-page',
    title: 'Open Add Document',
    contexts: ['action']
  });
});

chrome.contextMenus.onClicked.addListener(async function(info) {
  var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
  var [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  var newIndex = activeTab ? activeTab.index + 1 : undefined;

  if (info.menuItemId === 'open-docreview') {
    chrome.tabs.create({ url: baseUrl, index: newIndex });
  } else if (info.menuItemId === 'add-page') {
    chrome.tabs.create({ url: baseUrl + '/add', index: newIndex });
  }
});

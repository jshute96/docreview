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

  var { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl });
  chrome.tabs.create({ url: baseUrl + '/open?doc=' + encodeURIComponent(tab.url), index: tab.index + 1 });
});

// Handle messages from content scripts.
// - openDocInDocreview: from Gmail content script, opens doc in Docreview
// - ping: from docreview-bridge, returns extension status
// - resolveUrl: from docreview-bridge, follows redirects to resolve shortened URLs
// - navigateToComment: from docreview-bridge, navigates to a comment in an open Google Docs tab
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'openDocInDocreview' && sender.tab) {
    openDocFromGmailTab(sender.tab.id);
    return;
  }

  if (msg.type === 'ping') {
    console.log('[background] ping received');
    chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl, enableResolve: DEFAULTS.enableResolve, resolveHosts: DEFAULTS.resolveHosts }, function(config) {
      sendResponse({ version: 2, baseUrl: config.baseUrl, enableResolve: config.enableResolve, resolveHosts: config.resolveHosts });
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

  if (msg.type === 'navigateToComment') {
    navigateToComment(msg.docId, msg.discoId, msg.docUrl, msg.resolved, sender.tab).then(function(result) {
      console.log('[background] navigateToComment result:', result);
      sendResponse(result);
    }).catch(function(err) {
      console.error('[background] navigateToComment error:', err);
      sendResponse({ success: false, error: err.message });
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
// When discoId is empty, just deselects the active comment.
function navigateToCommentInPage(discoId, resolved, fallbackUrl) {
  // Find the closure_lm key and extract disco ID from a listitem
  var loggedFallback = false;
  function getDiscoId(item) {
    var lk = Object.keys(item).find(function(k) { return k.startsWith('closure_lm'); });
    if (!lk) return null;
    try {
      // Known path (may change when Google updates their code)
      var id = item[lk].listeners.click[0].Yd.Ai;
      if (typeof id === 'string' && id.match(/^AAAB/)) return id;
    } catch(e) {}

    // Fallback: deep search for AAAB-pattern strings in the click listener.
    // This handles cases where Google updates their minified property names.
    if (!loggedFallback) {
      console.log('[docreview-nav] fast path failed, using deep search fallback');
      loggedFallback = true;
    }
    try {
      var lm = item[lk];
      var clickHandlers = lm.listeners && lm.listeners.click;
      if (!clickHandlers) return null;
      var seen = new WeakSet();
      function findId(obj, depth) {
        if (depth > 12 || !obj) return null;
        if (typeof obj === 'object') {
          if (seen.has(obj)) return null;
          seen.add(obj);
        }
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length && i < 200; i++) {
          try {
            var v = obj[keys[i]];
            if (typeof v === 'string' && v.match(/^AAAB[A-Za-z0-9_-]{5,}$/) && v.length < 20) return v;
            if (typeof v === 'object' && v !== null && !(v instanceof HTMLElement) && !(v instanceof Window)) {
              var found = findId(v, depth + 1);
              if (found) return found;
            }
          } catch(e) {}
        }
        return null;
      }
      for (var h = 0; h < clickHandlers.length; h++) {
        var found = findId(clickHandlers[h], 0);
        if (found) return found;
      }
    } catch(e) {}
    return null;
  }

  // Google Docs buttons require a full mousedown+mouseup+click sequence;
  // a bare .click() is ignored by the Closure event system.
  function fullClick(el) {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // The comments pane has class docs-docos-activity-sidebar. There are multiple
  // [role="complementary"] elements on the page — we must use the specific class.
  function isCommentsPaneOpen() {
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    return panel && panel.offsetParent !== null;
  }

  // Open the comments pane (needed for resolved comments to be visible)
  function openCommentsPane() {
    if (isCommentsPaneOpen()) {
      console.log('[docreview-nav] comments pane already open');
      return Promise.resolve();
    }
    console.log('[docreview-nav] opening comments pane');
    var btn = document.querySelector('[aria-label*="Show all comments"]');
    if (!btn) { console.log('[docreview-nav] Show all comments button not found'); return Promise.resolve(); }
    fullClick(btn);
    // Wait for the pane to appear
    return new Promise(function(resolve) {
      var attempts = 0;
      var check = setInterval(function() {
        if (isCommentsPaneOpen() || ++attempts > 15) {
          clearInterval(check);
          console.log('[docreview-nav] comments pane open:', isCommentsPaneOpen());
          resolve();
        }
      }, 100);
    });
  }

  // Close the comments pane
  function closeCommentsPane() {
    if (!isCommentsPaneOpen()) return;
    console.log('[docreview-nav] closing comments pane');
    var panel = document.querySelector('.docs-docos-activity-sidebar');
    var closeBtn = panel ? panel.querySelector('[aria-label="Close"]') : null;
    if (closeBtn) fullClick(closeBtn);
  }

  // Ensure resolved comments are loaded in the DOM
  function ensureResolvedLoaded() {
    return new Promise(function(resolve) {
      if (!resolved) { resolve(); return; }

      // Check if resolved comments are already cached
      var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');
      for (var i = 0; i < items.length; i++) {
        if (items[i].textContent.indexOf('Resolved') !== -1) { resolve(); return; }
      }

      // Open the comments pane to load resolved comments
      console.log('[docreview-nav] loading resolved comments');
      openCommentsPane().then(function() {
        // Wait for resolved comments to appear in the DOM
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
    });
  }

  // Find the comment listitem by disco ID
  function findItem() {
    var items = document.querySelectorAll('#docos-stream-view [role="listitem"]');

    // First pass: prefer the right type (non-resolved for open, resolved for resolved)
    for (var i = 0; i < items.length; i++) {
      var id = getDiscoId(items[i]);
      if (id !== discoId) continue;
      var isResolvedEntry = items[i].textContent.indexOf('Resolved') !== -1;
      if (!resolved && isResolvedEntry) continue;
      return items[i];
    }

    // Second pass: accept any entry with the right ID
    for (var i = 0; i < items.length; i++) {
      if (getDiscoId(items[i]) === discoId) return items[i];
    }
    return null;
  }

  // Click the item. If the reply input isn't visible after 300ms, retry once.
  // Google Docs can process a click (setting the active class) without visually
  // expanding the comment during tab transitions.
  function clickWithRetry(item) {
    item.click();
    return new Promise(function(resolve) {
      setTimeout(function() {
        var replyInput = item.querySelector('.docos-input-textarea, [role="combobox"]');
        if (replyInput && replyInput.offsetParent !== null) {
          resolve(true);
          return;
        }
        console.log('[docreview-nav] comment not visually active, retrying click');
        item.click();
        resolve(true);
      }, 300);
    });
  }

  // Use an async wrapper so chrome.scripting.executeScript can await the result
  return (async function() {
    // No disco ID — nothing to navigate to
    if (!discoId) {
      return { success: true };
    }

    await ensureResolvedLoaded();

    if (resolved) {
      // For resolved comments, open the comments pane so the comment is visible
      await openCommentsPane();
    }

    var item = findItem();
    if (item) {
      await clickWithRetry(item);
      console.log('[docreview-nav] navigated to comment:', discoId);
      if (!resolved) {
        // For open comments, close the comments pane for a cleaner view
        closeCommentsPane();
      }
      return { success: true };
    }

    // Comment not found in the Closure tree
    console.log('[docreview-nav] comment not found:', discoId, '(searched', document.querySelectorAll('#docos-stream-view [role="listitem"]').length, 'items)');
    if (fallbackUrl) {
      console.log('[docreview-nav] falling back to page reload');
      location.href = fallbackUrl;
      return { success: true, fallback: true };
    }
    return { success: false, error: 'comment not found' };
  })();
}

// Handle a navigateToComment request from the Docreview web app.
// If we have a tracked tab for this doc, inject the navigation script.
// Otherwise, open a new tab with the disco= URL.
async function navigateToComment(docId, discoId, docUrl, resolved, senderTab) {
  var allTabs = await getDocTabs();
  var tabId = allTabs[docId];
  console.log('[background] navigateToComment:', { docId, discoId, resolved, trackedTabId: tabId, allTracked: allTabs });

  // Verify the tracked tab still exists and is on the right doc
  if (tabId) {
    try {
      var tab = await chrome.tabs.get(tabId);
      if (!tab || !tab.url || !tab.url.includes(docId)) {
        console.log('[background] tracked tab invalid, clearing:', { tabUrl: tab && tab.url, docId });
        await removeDocTab(docId);
        tabId = null;
      }
    } catch(e) {
      console.log('[background] tracked tab gone:', e.message);
      await removeDocTab(docId);
      tabId = null;
    }
  }

  // Build the disco= fallback URL
  var fallbackUrl = docUrl;
  if (discoId) {
    var u = new URL(docUrl);
    u.searchParams.set('disco', discoId);
    fallbackUrl = u.toString();
  }

  if (!tabId) {
    // No tracked tab — open a new one. Use disco= URL if we have an ID,
    // otherwise just open the doc at the top.
    console.log('[background] opening new tab:', { hasDisco: !!discoId });
    var newTabIndex = senderTab ? senderTab.index + 1 : undefined;
    var newTab = await chrome.tabs.create({ url: fallbackUrl, index: newTabIndex });
    await setDocTab(docId, newTab.id);
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

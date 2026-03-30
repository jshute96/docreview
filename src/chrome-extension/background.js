// Docreview Chrome Extension — Background Service Worker
//
// Handles toolbar icon clicks, context menu actions, and messages from content scripts.
// For Docs/Drive pages, the tab URL itself identifies the document.
// For Gmail, the doc URL must be extracted from the page at click time because:
//   - Gmail is a SPA; the tab URL is just mail.google.com/...
//   - Doc links live inside the message body, sometimes in sandboxed AMP iframes
//   - We use chrome.scripting.executeScript(allFrames: true) to reach into those
//     iframes, which content scripts can't access due to the sandbox origin being null
//
// Split into multiple files loaded via importScripts:
//   - background-injected.js: functions injected into page context (disco ID, navigation)
//   - background-comments.js: comment sync state and debounce logic
//   - background-tabs.js: Google Docs tab tracking for comment navigation
importScripts('defaults.js', 'background-injected.js', 'background-comments.js', 'background-tabs.js');

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
// Named function (not anonymous) so the _test:toolbarClick message handler below
// can call it. Playwright can't click the extension toolbar icon directly.
async function handleToolbarClick(tab) {
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
}

chrome.action.onClicked.addListener(handleToolbarClick);

// Handle messages from content scripts and the Docreview bridge.
//
// From Google Docs content script (content.js):
// - injectDiscoHelpers: inject disco ID helpers at page load
// - commentPre: pre-extract comment ID before Google mutates the DOM
// - commentActivity: trigger server-side comment sync (debounced)
// - trackDocTab: track a tab for comment navigation reuse
// - commentSelection: relay comment selected/deselected in the doc
//
// From Gmail content script (content.js):
// - openDocInDocreview: open doc from Gmail notification in Docreview
//
// From Docreview bridge (bridge-to-docreview.js → web app):
// - ping: return extension status and version
// - resolveUrl: follow redirects to resolve shortened URLs
// - cancelResolve: close in-flight resolve tabs
// - focusDocTab: focus an existing Google Docs tab without creating one
// - navigateToComment: navigate to a comment in an open Google Docs tab
// - selectComment: select a comment in the doc without focusing the tab

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  // From Docs content script: inject disco ID helpers on page load so
  // listComments() and getActiveCommentId() are available for debugging.
  if (msg.type === 'injectDiscoHelpers' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: injectDiscoIdHelpers,
      world: 'MAIN'
    }).catch(function(err) {
      console.warn('[background] injectDiscoHelpers failed for tab', sender.tab.id, ':', err.message);
    });
    return;
  }

  // From Docs content script: pre-extract the disco ID from a listitem marked
  // with [data-docreview-extract] while it's still in the DOM.
  if (msg.type === 'commentPre' && msg.docId && sender.tab) {
    // Inject shared helpers first (idempotent), then extract the ID.
    // Store the Promise so commentActivity can await it if it arrives
    // before extraction completes.
    var tabId = sender.tab.id;
    var promise = chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: injectDiscoIdHelpers,
      world: 'MAIN'
    }).then(function() {
      return chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: extractCommentIdFromPage,
        world: 'MAIN'
      });
    }).then(function(results) {
      var id = results && results[0] && results[0].result;
      if (id) {
        console.log('[background] extracted comment ID:', id, 'for tab', tabId);
      } else {
        console.log('[background] no comment ID extracted for tab', tabId);
      }
      return id || null;
    }).catch(function(err) {
      console.warn('[background] failed to extract comment ID:', err);
      return null;
    });
    pendingCommentIds.set(tabId, promise);
    return;
  }

  // From Docs content script: comment action detected, trigger server sync.
  if (msg.type === 'commentActivity' && msg.docId) {
    var docId = msg.docId;
    var commentType = msg.commentType;
    // Await the pre-extracted comment ID (may still be in flight)
    var pendingPromise = sender.tab ? pendingCommentIds.get(sender.tab.id) : null;
    if (sender.tab) pendingCommentIds.delete(sender.tab.id);
    (pendingPromise || Promise.resolve(null)).then(function(googleCommentId) {
      var label = syncLabel(commentType, googleCommentId);
      // Debounce key: per-comment when we have an ID, per-doc otherwise
      var key = googleCommentId ? docId + ':' + googleCommentId : docId;
      var state = commentSyncTimers.get(key);
      if (state) {
        // In cooldown — mark pending so trailing sync fires when cooldown expires
        state.pending = true;
        console.log('[background] commentActivity for', docId + label, '(cooldown active, trailing will fire)');
      } else {
        // No cooldown — fire immediately with hints and start cooldown
        console.log('[background] commentActivity for', docId + label, '(firing immediately)');
        fireCommentSync(docId, commentType, googleCommentId);
        var timerId = setTimeout(function() {
          var s = commentSyncTimers.get(key);
          commentSyncTimers.delete(key);
          // Only fire trailing sync if more events arrived during cooldown —
          // the leading sync may have missed their changes.
          if (s && s.pending) {
            console.log('[background] commentActivity for', docId + label, '(firing trailing after cooldown)');
            // Per-comment trailing: re-sync same comment. Per-doc trailing: full sync.
            fireCommentSync(docId, s.commentType, s.googleCommentId);
          }
        }, COMMENT_SYNC_COOLDOWN);
        commentSyncTimers.set(key, {
          timerId: timerId, pending: false,
          commentType: commentType, googleCommentId: googleCommentId
        });
      }
    });
    return;
  }

  // From Gmail content script: open the doc from a notification email.
  if (msg.type === 'openDocInDocreview' && sender.tab) {
    console.log('[background] openDocInDocreview from tab', sender.tab.id);
    openDocFromGmailTab(sender.tab.id);
    return;
  }

  // From Docs content script: track this tab for comment navigation reuse.
  if (msg.type === 'trackDocTab' && sender.tab) {
    chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs }, function(config) {
      if (!config.enableDocs) return;
      setDocTab(msg.docId, sender.tab.id);
      setDocTabName(sender.tab.id, msg.docId);
    });
    return;
  }

  // From Docreview bridge: return extension status and version.
  if (msg.type === 'ping') {
    console.log('[background] ping from docreview');
    chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl, enableDocs: DEFAULTS.enableDocs, enableResolve: DEFAULTS.enableResolve, resolveHosts: DEFAULTS.resolveHosts }, function(config) {
      sendResponse({ version: 2, baseUrl: config.baseUrl, enableDocs: config.enableDocs, enableResolve: config.enableResolve, resolveHosts: config.resolveHosts });
    });
    return true; // async response
  }

  // From Docreview bridge: follow redirects to resolve a shortened URL.
  if (msg.type === 'resolveUrl') {
    console.log('[background] resolveUrl from docreview:', msg.url);
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

  // From Docreview bridge: close in-flight URL resolve tabs.
  if (msg.type === 'cancelResolve') {
    cancelResolveTabs(msg.pageId);
    return;
  }

  // From Docreview bridge: focus an existing Google Docs tab without creating one.
  if (msg.type === 'focusDocTab') {
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

  // From Docreview bridge: navigate to a comment in an open Google Docs tab.
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

  // From Docs content script: comment selected/deselected in the doc.
  // Relay to all open Docreview tabs so the comments page can highlight the row.
  if (msg.type === 'commentSelection' && msg.docId) {
    console.log('[background] commentSelection from doc:', msg.docId, msg.selected ? msg.discoId : '(deselected)');
    chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl }, function(config) {
      chrome.tabs.query({ url: config.baseUrl + '/*' }, function(tabs) {
        if (!tabs || tabs.length === 0) return;
        console.log('[background] forwarding commentSelection to', tabs.length, 'docreview tab(s)');
        tabs.forEach(function(tab) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'commentSelection',
            docId: msg.docId,
            discoId: msg.discoId,
            selected: msg.selected
          }, function() {
            // Expected to fail on tabs without the bridge content script
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        });
      });
    });
    return;
  }

  // From Docreview bridge: select a comment in the Google Doc tab without
  // focusing it. Triggered by clicking a comment thread in the comments page.
  if (msg.type === 'selectComment' && msg.docId && msg.discoId) {
    console.log('[background] selectComment from docreview:', msg.docId, msg.discoId);
    (async function() {
      var config = await chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs });
      if (!config.enableDocs) return;
      var tabId = await findDocTab(msg.docId);
      if (!tabId) {
        console.log('[background] selectComment: no doc tab open for', msg.docId);
        return;
      }
      // Helpers are normally pre-installed at page load (content.js sends
      // injectDiscoHelpers), but re-inject as a safety net in case the tab
      // was opened before the extension was installed or the service worker
      // restarted. selectCommentInPage depends on window.__docreviewDisco.
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: injectDiscoIdHelpers,
        world: 'MAIN'
      }).catch(function(err) {
        console.warn('[background] selectComment: injectDiscoIdHelpers failed:', err.message);
      });
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: selectCommentInPage,
        args: [msg.discoId],
        world: 'MAIN'
      }).catch(function(err) {
        console.warn('[background] selectComment: selectCommentInPage failed:', err.message);
      });
    })();
    return;
  }

  // Test helper: simulate toolbar icon click. Called from Playwright tests via
  // chrome.runtime.sendMessage from an extension page (e.g. options.html), since
  // Playwright can't click extension toolbar icons or evaluate in SW scope.
  if (msg.type === '_test:toolbarClick' && msg.tabId) {
    (async function() {
      try {
        var tab = await chrome.tabs.get(msg.tabId);
        await handleToolbarClick(tab);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // From Docreview bridge: extract suggestion data from an open Google Docs tab.
  // Returns the full list of suggestions scraped from the DOM, including type,
  // old/new text, status, author, and reply threads.
  if (msg.type === 'getSuggestions' && msg.docId) {
    console.log('[background] getSuggestions from docreview:', msg.docId);
    (async function() {
      var config = await chrome.storage.sync.get({ enableDocs: DEFAULTS.enableDocs });
      if (!config.enableDocs) {
        sendResponse({ success: false, error: 'Google Docs integration is disabled' });
        return;
      }
      var tabId = await findDocTab(msg.docId);
      if (!tabId) {
        sendResponse({ success: false, error: 'no doc tab open' });
        return;
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: injectDiscoIdHelpers,
          world: 'MAIN'
        });
        var results = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: function() { return window.__docreviewDisco.getSuggestions(); },
          world: 'MAIN'
        });
        var suggestions = results && results[0] && results[0].result;
        sendResponse({ success: true, suggestions: suggestions || [] });
      } catch (err) {
        console.warn('[background] getSuggestions failed:', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async response
  }
});

// --- Comment navigation ---

// Check if a tab is in diff/version history view by injecting a detection script.
async function isTabInDiffView(tabId) {
  try {
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: isDiffViewFunc
    });
    return results && results[0] && results[0].result === true;
  } catch (e) {
    return false;
  }
}

// Handle a navigateToComment request from the Docreview web app.
// If we have a tracked tab for this doc, inject the navigation script.
// Otherwise, open a new tab with the disco= URL.
// If the tracked tab is in diff/version history view, open a new adjacent tab
// instead of navigating in the diff view (which doesn't work properly).
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

  // Check if the tracked tab is in diff/version history view. If so, open a new
  // adjacent tab for comment navigation instead of disrupting the diff view.
  var inDiffView = await isTabInDiffView(tabId);
  if (inDiffView) {
    console.log('[background] tracked tab is in diff/version history view, opening new adjacent tab:', { docId, tabId });
    try {
      var diffTab = await chrome.tabs.get(tabId);
      var newTab = await chrome.tabs.create({ url: fallbackUrl, index: diffTab.index + 1, windowId: diffTab.windowId });
      await setDocTab(docId, newTab.id);
      setDocTabName(newTab.id, docId);
      return { success: true, opened: true };
    } catch (e) {
      console.warn('[background] diff view tab disappeared, falling back to new tab:', e);
      var newTabIndex = senderTab ? senderTab.index + 1 : undefined;
      var newTab = await chrome.tabs.create({ url: fallbackUrl, index: newTabIndex });
      await setDocTab(docId, newTab.id);
      setDocTabName(newTab.id, docId);
      return { success: true, opened: true };
    }
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

  // Helpers are normally pre-installed at page load, but re-inject as a
  // safety net. navigateToCommentInPage depends on window.__docreviewDisco.
  console.log('[background] injecting navigation script for:', discoId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: injectDiscoIdHelpers,
      world: 'MAIN'
    });
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

// --- URL resolution ---
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

// --- Bridge script registration ---
// Dynamically register the bridge-to-docreview content script for the configured
// baseUrl. This lets the web app detect the extension and send it messages
// (e.g. to resolve shortened URLs). Re-registers whenever baseUrl changes.
var BRIDGE_SCRIPT_ID = 'bridge-to-docreview';

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
      js: ['defaults.js', 'bridge-to-docreview.js'],
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

// --- Context menu ---
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

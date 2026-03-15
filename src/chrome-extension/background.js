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
  var results = await chrome.scripting.executeScript({
    target: { tabId: tabId, allFrames: true },
    func: findDocUrlsInFramesFunc
  });
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
    });
  } else {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() { alert('Page is not a document supported in Docreview'); }
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
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'openDocInDocreview' && sender.tab) {
    openDocFromGmailTab(sender.tab.id);
    return;
  }

  if (msg.type === 'ping') {
    chrome.storage.sync.get({ baseUrl: DEFAULTS.baseUrl, enableResolve: DEFAULTS.enableResolve }, function(config) {
      sendResponse({ version: 1, baseUrl: config.baseUrl, enableResolve: config.enableResolve });
    });
    return true; // async response
  }

  if (msg.type === 'resolveUrl') {
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
});

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

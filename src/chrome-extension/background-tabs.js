// Doc tab tracking for in-page comment navigation.
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
    var matches = await findAllDocTabs(docId);
    if (matches.length > 0) {
      tabId = matches[0];
      await setDocTab(docId, tabId);
      console.log('[background] found existing doc tab by URL:', { docId, tabId });
    }
  }

  return tabId;
}

// Find all open Google Docs tabs whose URL contains the given doc ID.
// Used when we need to pick among multiple tabs for the same doc (e.g., the
// tracked tab is in diff view but a duplicated sibling tab isn't).
async function findAllDocTabs(docId) {
  var matches = [];
  try {
    var candidates = await chrome.tabs.query({ url: 'https://docs.google.com/*' });
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].url && candidates[i].url.includes('/d/' + docId + '/')) {
        matches.push(candidates[i].id);
      }
    }
  } catch (e) {
    // Query failed, return empty list
  }
  return matches;
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

// Clean up when tabs are closed.
// Also clears pendingCommentIds (defined in background-comments.js).
chrome.tabs.onRemoved.addListener(async function(tabId) {
  pendingCommentIds.delete(tabId);
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

// Open a new tab in `nearTab`'s window, immediately after it.
//
// `index` is only meaningful within a window, and chrome.tabs.create with no
// windowId puts the tab in Chrome's "current window" — which, from a service
// worker, means the last-focused-window bookkeeping Chrome maintains from
// windows.onFocusChanged. That is not "the window the user's gesture came
// from": with several windows open (especially across virtual desktops, where
// the window manager may not deliver the focus changes Chrome expects) it can
// still name a window the user left earlier, and the click doesn't correct it.
// The result is a tab opening at an arbitrary index in a window the user isn't
// looking at. So always pin placement to a concrete tab we know about.
//
// `nearTab` may be undefined (no gesture/sender tab available), in which case
// Chrome's default placement is all we have.
function createTabNextTo(url, nearTab, options) {
  return createTabNear(url, nearTab, options, true);
}

// Same, but only pins the window — the tab goes wherever Chrome puts it in that
// window (the end). For tabs the user didn't ask for, so we don't shove the tab
// strip around next to the tab they're looking at.
function createTabInWindowOf(url, nearTab, options) {
  return createTabNear(url, nearTab, options, false);
}

function createTabNear(url, nearTab, options, adjacent) {
  var props = Object.assign({ url: url }, options || {});
  if (!nearTab) return chrome.tabs.create(props);

  props.windowId = nearTab.windowId;
  if (adjacent) props.index = nearTab.index + 1;

  // Naming a windowId introduces a failure the unplaced call didn't have: if
  // that window closed since the gesture, create rejects with "No window with
  // id". Several callers are fire-and-forget, and a rejection there would drop
  // the user's action entirely — worse than misplacing the tab — so fall back
  // to default placement. (An out-of-range index needs no such handling;
  // Chrome clamps it.)
  return chrome.tabs.create(props).catch(function(err) {
    console.warn('[background] createTabNextTo: target window gone, using default placement:', err);
    delete props.windowId;
    delete props.index;
    return chrome.tabs.create(props);
  });
}

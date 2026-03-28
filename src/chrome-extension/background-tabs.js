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

// Content script for Docreview Chrome Extension.
// Injects Docreview icons into Google Docs, Drive, and Gmail.
//
// Comment activity detection and selection relay are in content-comments.js,
// loaded before this file via the manifest.
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
      // List view rows have a [data-column-id="16"] name column (empirically
      // observed — the column ID is not guaranteed stable across Drive updates).
      // Grid view rows inside <tr> elements don't have it. Use this to
      // distinguish the two layouts so we can apply fixed-width wrapper styling
      // only in list view (where column alignment matters).
      var nameColumn = row.querySelector('[data-column-id="16"]');
      var nameArea = nameColumn || row;

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
          if (nameColumn) {
            // List view: use a fixed-width wrapper so the injected icon doesn't
            // shift subsequent columns out of alignment.
            // Find the "icon branch" — the ancestor of the icon that is a direct
            // child of the container with the doc ID.
            var iconBranch = anchor;
            while (iconBranch.parentElement && iconBranch.parentElement !== idEl) {
              iconBranch = iconBranch.parentElement;
            }

            if (iconBranch.parentElement === idEl) {
              var btn = createIconButton(docId, 16);
              btn.style.marginRight = '0'; // override default 4px — wrapper handles spacing
              if (window.getComputedStyle(idEl).display !== 'flex') {
                idEl.style.display = 'flex';
                idEl.style.alignItems = 'center';
              }
              var btnWrapper = document.createElement('div');
              btnWrapper.className = 'dr-icon-wrapper';
              btnWrapper.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:28px;flex-shrink:0;';
              btnWrapper.appendChild(btn);
              idEl.insertBefore(btnWrapper, iconBranch);
            }
          } else {
            // Fallback for tr[role="row"] without a name column (unexpected layout).
            var btn = createIconButton(docId, 16);
            var parent = anchor.parentElement;
            if (window.getComputedStyle(parent).display !== 'flex') {
              parent.style.display = 'flex';
              parent.style.alignItems = 'center';
            }
            parent.insertBefore(btn, anchor);
          }
        }
      }
    });

    // Grid view: cells with role="gridcell". The gridcell elements live inside
    // <div role="row"> wrappers (not <tr>). The data-selection-key value varies
    // across Drive views (0 or 1 for files, 2 for folders in some views), so we
    // select all gridcells with a data-id and filter out folders by aria-label.
    var gridItems = document.querySelectorAll('[role="gridcell"][data-id]');
    gridItems.forEach(function(item) {
      // Folder aria-labels have "Folder" (or "Shared folder") as the type before
      // "Located in", e.g. "Notes Folder Located in My Drive...". Match only
      // in the type position — not in the location path (e.g. "Located in Test folder").
      var ariaLabel = item.getAttribute('aria-label') || '';
      var beforeLocated = ariaLabel.split('Located in')[0];
      if (/\bfolder\b/i.test(beforeLocated)) return;

      if (item.querySelector('.dr-link')) return;

      var docId = item.getAttribute('data-id');

      if (docId && docId.length > 20) {
        // Insert the icon inside the icon area (first child div with matching
        // data-id), next to the file type icon — mirroring the list view
        // approach. This keeps the icon in the same visibility/layout context
        // as the file type icon.
        var iconArea = item.querySelector('div[data-id="' + docId + '"]');
        if (iconArea) {
          var anchor = iconArea.querySelector('svg, img');
          if (anchor) {
            // Walk up from the icon to find the "icon branch" — the ancestor
            // that is a direct child of the icon area container.
            var iconBranch = anchor;
            while (iconBranch.parentElement && iconBranch.parentElement !== iconArea) {
              iconBranch = iconBranch.parentElement;
            }
            if (iconBranch.parentElement === iconArea) {
              var btn = createIconButton(docId, 16);
              // The grid card has a full-size absolutely-positioned background
              // overlay that covers non-positioned content. Drive's own icon
              // container uses position:relative to render above it. We must
              // do the same for our icon.
              btn.style.position = 'relative';
              iconArea.style.display = 'flex';
              iconArea.style.alignItems = 'center';
              iconArea.insertBefore(btn, iconBranch);
            }
          }
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

  // Set up injection and MutationObservers. Google Workspace apps load content
  // dynamically, so we need observers to inject into elements that appear after
  // the initial page load (titlebar in Docs, file list in Drive, emails in Gmail).
  if (docsEnabled) {
    injectDocs();
    injectAccessDenied();
    if (commentSyncEnabled) {
      setupCommentActivityDetection(function() { return commentSyncEnabled; });
      // Inject disco ID helpers at page load so listComments() and getActiveCommentId()
      // are available in the page console for debugging without needing a prior action.
      try {
        chrome.runtime.sendMessage({ type: 'injectDiscoHelpers' });
      } catch(e) {}
      setupCommentSelectionRelay();
    }
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

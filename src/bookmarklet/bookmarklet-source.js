/**
 * Docreview Bookmarklet
 * 
 * Injects a Docreview icon into Google Workspace.
 * Uses aggressive event interception to bypass Drive's row-selection logic.
 */
(function() {
  var hostname = location.hostname;
  var isDocs = hostname.endsWith('docs.google.com');
  var isDrive = hostname.endsWith('drive.google.com');

  if (!isDocs && !isDrive) return;

  // Global state management
  window._dr = window._dr || {};
  
  // Cleanup existing instance if any
  if (window._dr.observer) window._dr.observer.disconnect();
  if (window._dr.interval) clearInterval(window._dr.interval);
  if (window._dr.cleanup) {
    try { window._dr.cleanup(); } catch(e) {}
  }

  // Helper to create the icon button with capturing-phase interception
  function createIconButton(docId, size, originalUrl) {
    var btn = document.createElement('div');
    var openUrl = 'http://localhost:3000/open?doc=' + encodeURIComponent(originalUrl || ('https://docs.google.com/open?id=' + docId));
    
    btn.className = 'dr-link';
    btn.title = 'Open in Docreview';
    // Style as an inline block to sit left of the existing icon
    btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;vertical-align:middle;width:' + (size+4) + 'px;height:' + (size+4) + 'px;margin-right:4px;';

    var img = document.createElement('img');
    img.src = 'http://localhost:3000/docreview.svg';
    img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:2px;pointer-events:none;';
    btn.appendChild(img);

    // Event handler to stop Drive from seeing the click
    var handler = function(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === 'click' || (e.type === 'mouseup' && e.button === 0)) {
        window.open(openUrl, '_blank');
      }
      return false;
    };

    // Add listeners in capturing phase to win against Drive's listeners
    btn.addEventListener('click', handler, true);
    btn.addEventListener('mousedown', handler, true);
    btn.addEventListener('mouseup', handler, true);
    
    return btn;
  }

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
    
    var btn = createIconButton(m[1], 18, location.href);
    container.appendChild(btn);
    badges.insertBefore(container, badges.firstChild);
  }

  function injectDrive() {
    // 1. Tabular Views (List/Search)
    // Scan by rows to ensure we only pick the FIRST icon in each row (the Name column)
    var rows = document.querySelectorAll('[role="row"], tr');
    rows.forEach(function(row) {
      // If we already injected here, skip
      if (row.dataset.drIn === '1') return;

      // Find all potential icon containers in this row
      // We look for both .rxUYqf (list) and .qHF2df (often nested in buttons)
      var iconWrapper = row.querySelector('.rxUYqf, .qHF2df');
      if (!iconWrapper) return;

      // Ensure we haven't already added a link to this wrapper
      if (iconWrapper.querySelector('.dr-link')) {
        row.dataset.drIn = '1';
        return;
      }

      var idEl = iconWrapper.querySelector('[data-id]') || row.querySelector('[data-id]');
      var docId = idEl ? idEl.getAttribute('data-id') : null;

      if (docId && docId.length > 20) {
        row.dataset.drIn = '1';
        var btn = createIconButton(docId, 16);
        
        // Ensure the wrapper is flex for side-by-side icons
        if (window.getComputedStyle(iconWrapper).display !== 'flex') {
          iconWrapper.style.display = 'flex';
          iconWrapper.style.alignItems = 'center';
        }
        iconWrapper.insertBefore(btn, iconWrapper.firstChild);
      }
    });

    // 2. Boxes View (Grid)
    // Grid items are usually unique blocks, not rows
    var gridItems = document.querySelectorAll('.goen0e:not([data-dr-in="1"])');
    gridItems.forEach(function(item) {
      // Find the icon container within this grid item
      var iconWrapper = item.querySelector('.qHF2df') || item;
      if (iconWrapper.querySelector('.dr-link')) {
        item.setAttribute('data-dr-in', '1');
        return;
      }

      var idEl = item.closest('[data-id]') || item.querySelector('[data-id]');
      var docId = idEl ? idEl.getAttribute('data-id') : null;

      if (docId && docId.length > 20) {
        item.setAttribute('data-dr-in', '1');
        var btn = createIconButton(docId, 16);
        
        if (window.getComputedStyle(iconWrapper).display !== 'flex') {
          iconWrapper.style.display = 'flex';
          iconWrapper.style.alignItems = 'center';
        }
        iconWrapper.insertBefore(btn, iconWrapper.firstChild);
      }
    });
  }

  // Main entry point logic
  if (isDocs) {
    injectDocs();
  } else if (isDrive) {
    // Clear all markers to allow the bookmarklet to "refresh" if clicked again
    document.querySelectorAll('[data-dr-in]').forEach(function(el) {
      el.removeAttribute('data-dr-in');
    });
    
    injectDrive();
    window._dr.interval = setInterval(injectDrive, 2000);
    window._dr.observer = new MutationObserver(injectDrive);
    window._dr.observer.observe(document.body, { childList: true, subtree: true });
  }

  window._dr.cleanup = function() {
    // Listeners are on elements, nothing to global to clean up here
  };

  console.log('Docreview bookmarklet active');
})();

/**
 * Playwright DOM snapshot tests for the Chrome extension content script.
 *
 * These tests load saved DOM snapshots from Google Docs/Drive/Gmail,
 * inject the content script's functions directly (bypassing the IIFE's
 * hostname/storage checks), and verify that the expected DOM elements
 * are created.
 *
 * See testing/chrome-extension.md for the full test case descriptions.
 * See docs/notes-on-dom-snapshot-testing.md for background on this approach.
 */

import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// 1x1 transparent PNG as a data URI (placeholder for extension icons)
const ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==';

const EXTENSION_DIR = path.resolve(__dirname, '../../src/chrome-extension');

// Read the content script and extract function bodies from the IIFE.
const contentScriptSource = fs.readFileSync(
  path.join(EXTENSION_DIR, 'content.js'),
  'utf-8'
);

/**
 * Extract a named function definition from the source by matching balanced braces.
 */
function extractFunction(source: string, fnName: string): string {
  const marker = `function ${fnName}(`;
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) throw new Error(`Function ${fnName} not found in content.js`);

  const braceStart = source.indexOf('{', startIdx);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(startIdx, i + 1);
}

/**
 * Build a script that defines all content script functions with mocked
 * variables and calls the specified injection function.
 *
 * The content script's injectDocs() reads `location.pathname` and
 * `location.href` — we override these via a `location` variable that
 * shadows `window.location` inside the function scope.
 */
function buildInjectionScript(opts: {
  baseUrl: string;
  iconUrl: string;
  pathname: string;
  href: string;
  injectFn: 'injectDocs' | 'injectDrive' | 'injectGmail';
}): string {
  const functionNames = [
    'createIconButton',
    'injectDocs',
    'injectAccessDenied',
    'injectDrive',
    'injectGmail',
    'insertDocreviewLink',
  ];
  const functionBodies = functionNames
    .map((fn) => extractFunction(contentScriptSource, fn))
    .join('\n\n');

  // Wrap in an IIFE that provides the variables the functions expect.
  // We shadow `location` with a local variable to override hostname/pathname.
  return `(function() {
    var baseUrl = ${JSON.stringify(opts.baseUrl)};
    var iconUrl = ${JSON.stringify(opts.iconUrl)};
    var docsEnabled = ${opts.injectFn === 'injectDocs'};
    var driveEnabled = ${opts.injectFn === 'injectDrive'};
    var gmailEnabled = ${opts.injectFn === 'injectGmail'};
    var commentSyncEnabled = false;

    // Shadow window.location with a fake object so injectDocs() regex works
    var location = {
      hostname: ${JSON.stringify(opts.href.includes('docs.google.com') ? 'docs.google.com' : opts.href.includes('drive.google.com') ? 'drive.google.com' : opts.href.includes('mail.google.com') ? 'mail.google.com' : 'localhost')},
      pathname: ${JSON.stringify(opts.pathname)},
      href: ${JSON.stringify(opts.href)},
      search: '',
    };

    // Mock chrome.runtime.sendMessage for click handlers
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.runtime.sendMessage) window.chrome.runtime.sendMessage = function() {};

    ${functionBodies}

    ${opts.injectFn}();
  })();`;
}

async function injectContentScript(
  page: Page,
  opts: {
    pathname: string;
    href: string;
    injectFn: 'injectDocs' | 'injectDrive' | 'injectGmail';
  }
) {
  const script = buildInjectionScript({
    baseUrl: 'http://localhost:3000',
    iconUrl: ICON_DATA_URI,
    pathname: opts.pathname,
    href: opts.href,
    injectFn: opts.injectFn,
  });
  await page.evaluate(script);
}

// ---------------------------------------------------------------------------
// Google Docs
// ---------------------------------------------------------------------------

test.describe('Google Docs — content script injection', () => {
  const snapshot = '/google-docs.html';
  const opts = {
    pathname: '/document/d/1gnIihY34_-A9E3-mslqBrhZJDASME5do7X02wQQ6aew/edit',
    href: 'https://docs.google.com/document/d/1gnIihY34_-A9E3-mslqBrhZJDASME5do7X02wQQ6aew/edit',
    injectFn: 'injectDocs' as const,
  };

  test('fresh page — injects one #dr-badge with one .dr-link', async ({ page }) => {
    await page.goto(snapshot);

    expect(await page.locator('#dr-badge').count()).toBe(0);
    expect(await page.locator('.dr-link').count()).toBe(0);

    await injectContentScript(page, opts);

    expect(await page.locator('#dr-badge').count()).toBe(1);
    expect(await page.locator('.dr-link').count()).toBe(1);

    const img = page.locator('.dr-link img');
    expect(await img.count()).toBe(1);
    expect(await img.getAttribute('src')).toBeTruthy();
  });

  test('idempotency — running twice still produces exactly one badge', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);
    expect(await page.locator('#dr-badge').count()).toBe(1);

    await injectContentScript(page, opts);

    expect(await page.locator('#dr-badge').count()).toBe(1);
    expect(await page.locator('.dr-link').count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

test.describe('Google Sheets — content script injection', () => {
  const snapshot = '/google-sheets.html';
  const opts = {
    pathname: '/spreadsheets/d/1CisdoyGgI_q97l4WjjU5gvl0p8YRbh11XRLA4jUgZFk/edit',
    href: 'https://docs.google.com/spreadsheets/d/1CisdoyGgI_q97l4WjjU5gvl0p8YRbh11XRLA4jUgZFk/edit',
    injectFn: 'injectDocs' as const,
  };

  test('titlebar badge injected', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);

    expect(await page.locator('#dr-badge').count()).toBe(1);
    expect(await page.locator('.dr-link').count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Google Slides
// ---------------------------------------------------------------------------

test.describe('Google Slides — content script injection', () => {
  const snapshot = '/google-slides.html';
  const opts = {
    pathname: '/presentation/d/1MKMuNqbfbzZXFsFSYXIpnpGzSJsdrbLZD0tGP0Lhlmk/edit',
    href: 'https://docs.google.com/presentation/d/1MKMuNqbfbzZXFsFSYXIpnpGzSJsdrbLZD0tGP0Lhlmk/edit',
    injectFn: 'injectDocs' as const,
  };

  test('titlebar badge injected', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);

    expect(await page.locator('#dr-badge').count()).toBe(1);
    expect(await page.locator('.dr-link').count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Google Drive — list view
// ---------------------------------------------------------------------------

test.describe('Google Drive — list view content script injection', () => {
  const snapshot = '/google-drive-list.html';
  const opts = {
    pathname: '/drive/my-drive',
    href: 'https://drive.google.com/drive/my-drive',
    injectFn: 'injectDrive' as const,
  };

  test('injects .dr-link into qualifying file rows', async ({ page }) => {
    await page.goto(snapshot);

    const qualifyingBefore = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('tr[role="row"]').forEach((row) => {
        const nameArea = row.querySelector('[data-column-id="16"]') || row;
        const nameEl = nameArea.querySelector('[data-tooltip]');
        if (nameEl && /\bfolder$/i.test(nameEl.getAttribute('data-tooltip') || ''))
          return;
        const idEl =
          nameArea.querySelector('[data-id]') || row.querySelector('[data-id]');
        const docId = idEl ? idEl.getAttribute('data-id') : null;
        if (docId && docId.length > 20 && nameArea.querySelector('svg, img')) count++;
      });
      return count;
    });

    expect(qualifyingBefore).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    const drLinkCount = await page.locator('.dr-link').count();
    expect(drLinkCount).toBeGreaterThan(0);
    expect(drLinkCount).toBeLessThanOrEqual(qualifyingBefore);
  });

  test('idempotency — running twice produces no duplicates', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);

    const countAfterFirst = await page.locator('.dr-link').count();
    expect(countAfterFirst).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-link').count()).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Google Drive — grid view
// ---------------------------------------------------------------------------

test.describe('Google Drive — grid view content script injection', () => {
  const snapshot = '/google-drive-grid.html';
  const opts = {
    pathname: '/drive/folders/1A8RM25Uj8nwwDNcuou2pGnYvwePIg',
    href: 'https://drive.google.com/drive/folders/1A8RM25Uj8nwwDNcuou2pGnYvwePIg',
    injectFn: 'injectDrive' as const,
  };

  test('injects .dr-link into qualifying gridcell items', async ({ page }) => {
    await page.goto(snapshot);

    const qualifyingBefore = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('[role="gridcell"][data-id]').forEach((item) => {
        const ariaLabel = item.getAttribute('aria-label') || '';
        if (/\bfolder\b/i.test(ariaLabel.split('Located in')[0])) return;
        const docId = item.getAttribute('data-id');
        if (docId && docId.length > 20 && item.querySelector('svg, img')) count++;
      });
      return count;
    });

    expect(qualifyingBefore).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    const drLinkCount = await page.locator('.dr-link').count();
    expect(drLinkCount).toBeGreaterThan(0);
    expect(drLinkCount).toBeLessThanOrEqual(qualifyingBefore);
  });

  test('idempotency — running twice produces no duplicates', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);

    const countAfterFirst = await page.locator('.dr-link').count();
    expect(countAfterFirst).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-link').count()).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Google Drive — grid view (My Drive with folders + files)
// ---------------------------------------------------------------------------

test.describe('Google Drive — grid view (My Drive) content script injection', () => {
  const snapshot = '/google-drive-grid2.html';
  const opts = {
    pathname: '/drive/my-drive',
    href: 'https://drive.google.com/drive/my-drive',
    injectFn: 'injectDrive' as const,
  };

  test('injects .dr-link into file gridcells but not folders', async ({ page }) => {
    await page.goto(snapshot);

    const { files, folders } = await page.evaluate(() => {
      let files = 0, folders = 0;
      document.querySelectorAll('[role="gridcell"][data-id]').forEach((item) => {
        const ariaLabel = item.getAttribute('aria-label') || '';
        if (/\bfolder\b/i.test(ariaLabel.split('Located in')[0])) { folders++; return; }
        const docId = item.getAttribute('data-id');
        if (docId && docId.length > 20 && item.querySelector('svg, img')) files++;
      });
      return { files, folders };
    });

    expect(files).toBeGreaterThan(0);
    expect(folders).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    const drLinkCount = await page.locator('.dr-link').count();
    expect(drLinkCount).toBeGreaterThan(0);
    expect(drLinkCount).toBeLessThanOrEqual(files);
  });

  test('idempotency — running twice produces no duplicates', async ({ page }) => {
    await page.goto(snapshot);
    await injectContentScript(page, opts);

    const countAfterFirst = await page.locator('.dr-link').count();
    expect(countAfterFirst).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-link').count()).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Gmail — inbox list chips
// ---------------------------------------------------------------------------

test.describe('Gmail — inbox chip injection', () => {
  const snapshot = '/gmail-inbox.html';
  const opts = {
    pathname: '/mail/u/1/',
    href: 'https://mail.google.com/mail/u/1/#inbox',
    injectFn: 'injectGmail' as const,
  };

  test('injects .dr-link into [data-docurl] chips', async ({ page }) => {
    await page.goto(snapshot, { waitUntil: 'load', timeout: 30_000 });

    const chipCount = await page.evaluate(
      () => document.querySelectorAll('[data-docurl]').length
    );
    expect(chipCount).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    const drLinkCount = await page.locator('.dr-link').count();
    expect(drLinkCount).toBe(chipCount);
  });

  test('idempotency — running twice produces no duplicates', async ({ page }) => {
    await page.goto(snapshot, { waitUntil: 'load', timeout: 30_000 });
    await injectContentScript(page, opts);

    const countAfterFirst = await page.locator('.dr-link').count();
    expect(countAfterFirst).toBeGreaterThan(0);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-link').count()).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Gmail — message view bar
// ---------------------------------------------------------------------------

test.describe('Gmail — message view bar injection', () => {
  const snapshot = '/gmail-message.html';
  const opts = {
    pathname: '/mail/u/1/',
    href: 'https://mail.google.com/mail/u/1/#inbox/FMfcgzQgKvGtMmxRdFFGMnrMSVRQKGKg',
    injectFn: 'injectGmail' as const,
  };

  test('injects .dr-gmail-bar above message iframe', async ({ page }) => {
    await page.goto(snapshot, { waitUntil: 'load', timeout: 30_000 });

    const hasMsgDiv = await page.evaluate(
      () => document.querySelectorAll('[data-message-id]').length > 0
    );
    expect(hasMsgDiv).toBe(true);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-gmail-bar').count()).toBeGreaterThanOrEqual(1);

    const barText = await page.locator('.dr-gmail-bar').first().textContent();
    expect(barText).toContain('Open in');
    expect(barText).toContain('Docreview');

    expect(
      await page.locator('.dr-gmail-bar img').first().getAttribute('src')
    ).toBeTruthy();
  });

  test('idempotency — running twice still produces one bar per message', async ({ page }) => {
    await page.goto(snapshot, { waitUntil: 'load', timeout: 30_000 });
    await injectContentScript(page, opts);

    const countAfterFirst = await page.locator('.dr-gmail-bar').count();
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    await injectContentScript(page, opts);

    expect(await page.locator('.dr-gmail-bar').count()).toBe(countAfterFirst);
  });
});

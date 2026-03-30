/**
 * Tests for the Chrome extension toolbar icon (browser action).
 *
 * Playwright can't click extension toolbar icons or evaluate in the service
 * worker's full scope. Instead, tests open the extension's options page for
 * chrome API access, and call chrome.runtime.sendMessage to invoke
 * handleToolbarClick in the background script via a _test:toolbarClick message.
 */

import { test, expect } from './fixtures';
import { TEST_BASE_URL } from '../shared/test-env';

test.describe('Extension toolbar icon', () => {
  test.beforeEach(async ({ extPage }) => {
    // Point the extension at the test server
    await extPage.evaluate(async (baseUrl) => {
      await chrome.storage.sync.set({ baseUrl });
    }, TEST_BASE_URL);
  });

  test('extension loads and service worker starts', async ({ background }) => {
    const url = background.url();
    expect(url).toContain('chrome-extension://');
  });

  test('blank page opens docreview', async ({ context, extPage }) => {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('about:blank');

    // Get the tab ID for this page
    const tabId = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t: chrome.tabs.Tab) => t.url === 'about:blank' || !t.url);
      return tab?.id;
    });
    expect(tabId).toBeTruthy();

    // Simulate toolbar click via background script message
    const result = await extPage.evaluate(async (id) => {
      return await chrome.runtime.sendMessage({ type: '_test:toolbarClick', tabId: id });
    }, tabId);
    expect(result.success).toBe(true);

    // Handler navigates blank pages to docreview; offline auto-login redirects to /docs
    await page.waitForURL('**/docs', { timeout: 15_000 });
  });

  test('non-doc page shows error alert', async ({ context, extPage }) => {
    const page = context.pages()[0] || await context.newPage();

    // Navigate to docreview (localhost — not a Google Doc URL)
    await page.goto(TEST_BASE_URL + '/login');
    await page.waitForURL('**/docs', { timeout: 15_000 });

    const pageUrl = page.url();
    const tabId = await extPage.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t: chrome.tabs.Tab) => t.url === url);
      return tab?.id;
    }, pageUrl);
    expect(tabId).toBeTruthy();

    // Listen for the alert before triggering it
    const dialogPromise = page.waitForEvent('dialog');

    await extPage.evaluate(async (id) => {
      return await chrome.runtime.sendMessage({ type: '_test:toolbarClick', tabId: id });
    }, tabId);

    const dialog = await dialogPromise;
    expect(dialog.message()).toContain('not a document supported in Docreview');
    await dialog.accept();
  });
});

/**
 * Tests for the Chrome extension options page.
 *
 * These tests verify the options page UI, save/load behavior, URL normalization,
 * checkbox dependencies, and that saved settings affect extension behavior.
 */

import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import { TEST_BASE_URL } from '../shared/test-env';

/** Helper: clear all extension storage before each test */
async function clearStorage(extPage: Page) {
  await extPage.evaluate(async () => {
    await chrome.storage.sync.clear();
  });
}

/** Helper: navigate to options page and wait for it to be visible */
async function openOptions(extPage: Page, extensionId: string) {
  await extPage.goto(`chrome-extension://${extensionId}/options.html`);
  await extPage.waitForFunction(() => document.body.style.visibility !== 'hidden');
}

test.describe('Extension options page', () => {
  test.beforeEach(async ({ extPage, extensionId }) => {
    await clearStorage(extPage);
    await openOptions(extPage, extensionId);
  });

  test('opens as a full browser tab', async ({ extPage }) => {
    // The options page should be a full tab (not a popup).
    // Verify by checking that manifest has open_in_tab: true — at runtime,
    // the page is already open as a tab via our fixture's goto().
    // We verify the page renders with full-width layout (no fixed width on html).
    const htmlWidth = await extPage.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return style.width;
    });
    // In a popup, width would be fixed at 480px. In a tab, it fills the viewport.
    const width = parseInt(htmlWidth);
    expect(width).toBeGreaterThan(600);
  });

  test('loads with default values when no settings saved', async ({ extPage }) => {
    const values = await extPage.evaluate(() => ({
      baseUrl: (document.getElementById('baseUrl') as HTMLInputElement).value,
      enableDocs: (document.getElementById('enableDocs') as HTMLInputElement).checked,
      enableCommentSync: (document.getElementById('enableCommentSync') as HTMLInputElement).checked,
      enableDrive: (document.getElementById('enableDrive') as HTMLInputElement).checked,
      enableGmail: (document.getElementById('enableGmail') as HTMLInputElement).checked,
      enableResolve: (document.getElementById('enableResolve') as HTMLInputElement).checked,
    }));
    expect(values.baseUrl).toBe('http://localhost:3000');
    expect(values.enableDocs).toBe(true);
    expect(values.enableCommentSync).toBe(true);
    expect(values.enableDrive).toBe(true);
    expect(values.enableGmail).toBe(true);
    expect(values.enableResolve).toBe(false);
  });

  test('save persists settings to chrome.storage.sync', async ({ extPage }) => {
    // Change the URL and uncheck Drive
    await extPage.fill('#baseUrl', 'https://docreview.example.com');
    await extPage.uncheck('#enableDrive');
    await extPage.click('#save');

    // Read back from storage
    const stored = await extPage.evaluate(async () => {
      return await chrome.storage.sync.get(['baseUrl', 'enableDrive']);
    });
    expect(stored.baseUrl).toBe('https://docreview.example.com');
    expect(stored.enableDrive).toBe(false);
  });

  test('save button shows "Saved" confirmation briefly', async ({ extPage }) => {
    await extPage.click('#save');
    await expect(extPage.locator('#save')).toHaveText('Saved');
    // Wait for it to revert
    await expect(extPage.locator('#save')).toHaveText('Save', { timeout: 3000 });
  });

  test('reload page reverts unsaved edits', async ({ extPage, extensionId }) => {
    // Save a known URL first
    await extPage.fill('#baseUrl', 'https://saved.example.com');
    await extPage.click('#save');
    await expect(extPage.locator('#save')).toHaveText('Saved');

    // Make unsaved edits
    await extPage.fill('#baseUrl', 'https://unsaved.example.com');
    await extPage.uncheck('#enableDocs');

    // Reload
    await openOptions(extPage, extensionId);

    // Should show the saved values, not the unsaved edits
    const values = await extPage.evaluate(() => ({
      baseUrl: (document.getElementById('baseUrl') as HTMLInputElement).value,
      enableDocs: (document.getElementById('enableDocs') as HTMLInputElement).checked,
    }));
    expect(values.baseUrl).toBe('https://saved.example.com');
    expect(values.enableDocs).toBe(true);
  });

  test('saved URL strips whitespace and trailing slashes, display updates', async ({ extPage }) => {
    await extPage.fill('#baseUrl', '  https://example.com///  ');
    await extPage.click('#save');

    // The input field should show the normalized URL
    const displayValue = await extPage.inputValue('#baseUrl');
    expect(displayValue).toBe('https://example.com');

    // Storage should also have the normalized URL
    const stored = await extPage.evaluate(async () => {
      return await chrome.storage.sync.get(['baseUrl']);
    });
    expect(stored.baseUrl).toBe('https://example.com');
  });

  test('unchecking Docs auto-unchecks comment sync', async ({ extPage }) => {
    // Both should start checked
    await expect(extPage.locator('#enableDocs')).toBeChecked();
    await expect(extPage.locator('#enableCommentSync')).toBeChecked();
    await expect(extPage.locator('#enableCommentSync')).toBeEnabled();

    // Uncheck Docs
    await extPage.uncheck('#enableDocs');

    // Comment sync should be unchecked and disabled
    await expect(extPage.locator('#enableCommentSync')).not.toBeChecked();
    await expect(extPage.locator('#enableCommentSync')).toBeDisabled();
  });

  test('re-checking Docs re-enables comment sync (but stays unchecked)', async ({ extPage }) => {
    await extPage.uncheck('#enableDocs');
    await expect(extPage.locator('#enableCommentSync')).toBeDisabled();

    await extPage.check('#enableDocs');
    await expect(extPage.locator('#enableCommentSync')).toBeEnabled();
    // It was auto-unchecked, so it should stay unchecked until manually checked
    await expect(extPage.locator('#enableCommentSync')).not.toBeChecked();
  });

  test('URL resolver toggle saves correctly', async ({ extPage }) => {
    // Default is off
    await expect(extPage.locator('#enableResolve')).not.toBeChecked();

    // Enable and save
    await extPage.check('#enableResolve');
    await extPage.click('#save');

    const stored = await extPage.evaluate(async () => {
      return await chrome.storage.sync.get(['enableResolve']);
    });
    expect(stored.enableResolve).toBe(true);
  });

  test('loads previously saved settings on page open', async ({ extPage, extensionId }) => {
    // Save non-default settings via storage API
    await extPage.evaluate(async () => {
      await chrome.storage.sync.set({
        baseUrl: 'https://custom.example.com',
        enableDocs: false,
        enableCommentSync: false,
        enableDrive: false,
        enableGmail: false,
        enableResolve: true,
      });
    });

    // Reopen options page
    await openOptions(extPage, extensionId);

    const values = await extPage.evaluate(() => ({
      baseUrl: (document.getElementById('baseUrl') as HTMLInputElement).value,
      enableDocs: (document.getElementById('enableDocs') as HTMLInputElement).checked,
      enableCommentSync: (document.getElementById('enableCommentSync') as HTMLInputElement).checked,
      enableDrive: (document.getElementById('enableDrive') as HTMLInputElement).checked,
      enableGmail: (document.getElementById('enableGmail') as HTMLInputElement).checked,
      enableResolve: (document.getElementById('enableResolve') as HTMLInputElement).checked,
    }));
    expect(values.baseUrl).toBe('https://custom.example.com');
    expect(values.enableDocs).toBe(false);
    expect(values.enableCommentSync).toBe(false);
    expect(values.enableDrive).toBe(false);
    expect(values.enableGmail).toBe(false);
    expect(values.enableResolve).toBe(true);
  });

  test('no flash of default values on load', async ({ extPage, extensionId }) => {
    // Save non-default URL
    await extPage.evaluate(async () => {
      await chrome.storage.sync.set({ baseUrl: 'https://custom.example.com' });
    });

    // Navigate to options page — body starts hidden
    await extPage.goto(`chrome-extension://${extensionId}/options.html`);

    // Wait for storage to load and body to become visible, then verify
    // it shows saved values (not defaults). Timing-dependent — storage may
    // load before we can observe the hidden state.
    await extPage.waitForFunction(() => document.body.style.visibility !== 'hidden');
    const url = await extPage.inputValue('#baseUrl');
    expect(url).toBe('https://custom.example.com');
  });
});

test.describe('Saved settings affect extension behavior', () => {
  test('custom Docreview URL is used by toolbar click', async ({ context, extPage }) => {
    // Set a custom URL pointing to the test server
    await extPage.evaluate(async (baseUrl) => {
      await chrome.storage.sync.set({ baseUrl });
    }, TEST_BASE_URL);

    // Open a blank page and simulate toolbar click
    const page = context.pages()[0] || await context.newPage();
    await page.goto('about:blank');

    const tabId = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t: chrome.tabs.Tab) => t.url === 'about:blank' || !t.url);
      return tab?.id;
    });
    expect(tabId).toBeTruthy();

    await extPage.evaluate(async (id) => {
      return await chrome.runtime.sendMessage({ type: '_test:toolbarClick', tabId: id });
    }, tabId);

    // Should navigate to the custom URL (offline mode auto-redirects to /docs)
    await page.waitForURL(`${TEST_BASE_URL}/**`, { timeout: 15_000 });
    expect(page.url()).toContain(TEST_BASE_URL);
  });

  test('changing URL changes where toolbar click navigates', async ({ context, extPage }) => {
    // First set one URL
    await extPage.evaluate(async (baseUrl) => {
      await chrome.storage.sync.set({ baseUrl });
    }, 'http://localhost:9999');

    // Now change it to the test server
    await extPage.evaluate(async (baseUrl) => {
      await chrome.storage.sync.set({ baseUrl });
    }, TEST_BASE_URL);

    const page = context.pages()[0] || await context.newPage();
    await page.goto('about:blank');

    const tabId = await extPage.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t: chrome.tabs.Tab) => t.url === 'about:blank' || !t.url);
      return tab?.id;
    });

    await extPage.evaluate(async (id) => {
      return await chrome.runtime.sendMessage({ type: '_test:toolbarClick', tabId: id });
    }, tabId);

    // Should use the updated URL, not the old one
    await page.waitForURL(`${TEST_BASE_URL}/**`, { timeout: 15_000 });
    expect(page.url()).toContain(TEST_BASE_URL);
  });
});

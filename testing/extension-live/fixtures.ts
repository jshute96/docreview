/**
 * Shared fixtures for extension-live tests.
 *
 * Extensions require a persistent browser context with Playwright's bundled
 * Chromium (system Chrome removed support for --load-extension). See:
 * https://playwright.dev/docs/chrome-extensions
 *
 * Extensions don't work in Chromium's headless shell, so the fixtures force
 * headed mode (headless: false). A DISPLAY is needed for CI.
 */

import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import * as path from 'path';
import { PROJECT_ROOT } from '../shared/test-env';

const EXTENSION_DIR = path.join(PROJECT_ROOT, 'src', 'chrome-extension');

type ExtensionFixtures = {
  context: BrowserContext;
  background: Worker;
  extensionId: string;
  /** Extension options page — gives full chrome API access for test setup */
  extPage: Page;
};

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    await use(context);
    await context.close();
  },

  background: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },

  extensionId: async ({ background }, use) => {
    const id = background.url().split('/')[2];
    await use(id);
  },

  // Navigate to the extension's options page to get full chrome API access.
  // worker.evaluate() runs in a sandboxed utility context without chrome.storage,
  // chrome.scripting, etc. Any extension-origin page provides the real APIs.
  extPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';

/**
 * Playwright config for testing docreview with the Chrome extension loaded.
 *
 * Starts a Next.js dev server on port 3010 (offline mode) and launches
 * Chrome with the extension loaded via --load-extension.
 *
 * Prerequisites:
 *   testing/setup-test-db.sh   # create and migrate the test database
 *   Chrome extension built in src/chrome-extension/
 */

import * as path from 'path';
import { defineConfig } from '@playwright/test';
import { TEST_BASE_URL, TEST_PORT, buildServerCommand, PROJECT_ROOT } from '../shared/test-env';

const EXTENSION_DIR = path.join(PROJECT_ROOT, 'src', 'chrome-extension');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: TEST_BASE_URL,
    // Cannot use channel: 'chrome' with extensions — need full Chromium launch
    launchOptions: {
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    },
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: buildServerCommand({ offline: true }),
    port: TEST_PORT,
    cwd: PROJECT_ROOT,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

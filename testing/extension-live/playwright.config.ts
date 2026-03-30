/**
 * Playwright config for testing docreview with the Chrome extension loaded.
 *
 * Starts a Next.js dev server on port 3010 (offline mode). Browser launch
 * is handled by the fixtures (persistent context with extension), not this
 * config's `use` block — the `use` settings here are just for baseURL/defaults.
 *
 * Prerequisites:
 *   testing/setup-test-db.sh   # create and migrate the test database
 *   npx playwright install chromium  # bundled Chromium (system Chrome can't load extensions)
 */

import { defineConfig } from '@playwright/test';
import { TEST_BASE_URL, TEST_PORT, buildServerCommand, PROJECT_ROOT } from '../shared/test-env';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: TEST_BASE_URL,
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

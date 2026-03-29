/**
 * Playwright config for testing docreview in offline mode.
 *
 * Starts a Next.js dev server on port 3010 with OFFLINE_MODE=true
 * and a separate test database (docreview_test).
 *
 * Prerequisites:
 *   testing/setup-test-db.sh   # create and migrate the test database
 */

import { defineConfig } from '@playwright/test';
import { TEST_BASE_URL, TEST_PORT, buildServerCommand, PROJECT_ROOT, getFirstTestUser } from '../shared/test-env';

const testUser = getFirstTestUser();

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  retries: 0,
  // Single worker: label tests mutate shared DB state and cross-tab
  // broadcasts (BroadcastChannel) leak across contexts on the same origin.
  workers: 1,
  use: {
    baseURL: TEST_BASE_URL,
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
    command: buildServerCommand({ offline: true, userId: testUser?.user_id }),
    port: TEST_PORT,
    cwd: PROJECT_ROOT,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

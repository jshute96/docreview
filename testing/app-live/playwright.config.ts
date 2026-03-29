/**
 * Playwright config for testing docreview with real Google login.
 *
 * Starts a Next.js dev server on port 3010 (online mode) and uses
 * stored auth state to bypass interactive OAuth login.
 *
 * Prerequisites:
 *   testing/setup-test-db.sh           # create and migrate the test database
 *   testing/app-live/auth-setup.ts     # one-time interactive login to save auth state
 */

import { defineConfig } from '@playwright/test';
import { TEST_BASE_URL, TEST_PORT, buildServerCommand, PROJECT_ROOT } from '../shared/test-env';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000, // longer timeout for Google API calls
  retries: 0,
  use: {
    baseURL: TEST_BASE_URL,
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    // Use saved auth state so tests don't need interactive Google login
    // storageState: 'testing/app-live/.auth/user.json',
  },
  webServer: {
    command: buildServerCommand({ offline: false }),
    port: TEST_PORT,
    cwd: PROJECT_ROOT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

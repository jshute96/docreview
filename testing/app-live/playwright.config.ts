/**
 * Playwright config for testing docreview with real Google login.
 *
 * Uses a setup project to validate/create auth state before running tests.
 * The setup project opens a headed browser for interactive Google OAuth
 * if no valid saved session exists.
 *
 * Prerequisites:
 *   testing/setup-test-db.sh                   # create and migrate the test database
 *   scripts/run-test.sh testing/app-live/ --headed   # first run needs --headed for login
 *
 * After the first successful login, auth state is saved to .auth/user.json
 * and reused on subsequent runs (until the session expires).
 */

import { defineConfig } from '@playwright/test';
import { TEST_BASE_URL, TEST_PORT, buildServerCommand, PROJECT_ROOT } from '../shared/test-env';

export default defineConfig({
  testDir: '.',
  timeout: 60_000, // longer timeout for Google API calls
  retries: 0,
  workers: 1, // tests share DB state and Drive comments
  use: {
    baseURL: TEST_BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'tests',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        storageState: 'testing/app-live/.auth/user.json',
      },
    },
  ],
  webServer: {
    command: buildServerCommand({ offline: false }),
    port: TEST_PORT,
    cwd: PROJECT_ROOT,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

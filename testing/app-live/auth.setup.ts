/**
 * Playwright setup: ensure we have a valid session for app-live tests.
 *
 * Looks up a non-expired session for the first test user in the test database
 * and sets the authjs session cookie directly. This avoids interactive
 * Google OAuth login (which Google blocks in automated browsers).
 *
 * If no valid session exists, the test fails with instructions to log in
 * manually via open-browser-live.sh first.
 */

import { test as setup, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getTestDb, disconnectTestDb } from '../shared/test-db';
import { getFirstTestUser } from '../shared/test-env';

const AUTH_DIR = path.join(__dirname, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'user.json');

/** Cookie name NextAuth v5 uses for database sessions over HTTP */
const SESSION_COOKIE = 'authjs.session-token';

setup('authenticate', async ({ page, context }) => {
  // Try to reuse saved auth state first
  if (fs.existsSync(AUTH_FILE)) {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
    }
    // Login page redirects to /docs server-side if the session is valid
    await page.goto('/login');
    if (page.url().includes('/docs')) {
      return;
    }
  }

  // Look up a valid session from the test DB
  const testUser = getFirstTestUser();
  if (!testUser) throw new Error('No test user found in test_users.json');

  const db = getTestDb();
  try {
    const session = await (db as any).session.findFirst({
      where: {
        expires: { gt: new Date() },
        user: { email: testUser.user },
      },
      orderBy: { expires: 'desc' },
    });

    if (!session) {
      throw new Error(
        `No valid session for ${testUser.user} in the test database.\n` +
        'Log in manually first:\n' +
        '  1. testing/dev-test.sh          # start test server on port 3009\n' +
        '  2. testing/open-browser-live.sh  # open Chrome and log in'
      );
    }

    // Set the session cookie
    await context.addCookies([{
      name: SESSION_COOKIE,
      value: session.sessionToken,
      domain: 'localhost',
      path: '/',
    }]);

    // Verify the session works
    await page.goto('/login');
    expect(page.url()).toContain('/docs');

    // Save auth state for faster startup on subsequent runs
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: AUTH_FILE });
  } finally {
    await disconnectTestDb();
  }
});

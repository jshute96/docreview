/**
 * Shared test environment configuration.
 *
 * Reads the production .env, derives the test DATABASE_URL, and provides
 * constants used by all Playwright configs that run a real docreview instance.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_DIR = path.resolve(__dirname, '../..');
const ENV_FILE = path.join(PROJECT_DIR, '.env');

/** Read a value from the .env file */
function readEnvVar(name: string): string | undefined {
  if (!fs.existsSync(ENV_FILE)) return undefined;
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  const match = content.match(new RegExp(`^${name}=(.+)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

/** Production DATABASE_URL from .env */
const PROD_DATABASE_URL = readEnvVar('DATABASE_URL');

/** Test database URL — same connection but database name is docreview_test */
export const TEST_DATABASE_URL = PROD_DATABASE_URL
  ? PROD_DATABASE_URL.replace(/\/[^/]*$/, '/docreview_test')
  : 'postgresql://localhost:5432/docreview_test';

/** Port for the test docreview instance */
export const TEST_PORT = 3010;

/** Base URL for the test docreview instance */
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;

/**
 * Build the shell command to start Next.js for testing.
 *
 * @param offline - Whether to enable OFFLINE_MODE (default: true)
 */
export function buildServerCommand(opts: { offline?: boolean; userId?: string } = {}): string {
  const offline = opts.offline ?? true;
  const env = [
    `DATABASE_URL=${TEST_DATABASE_URL}`,
    `PORT=${TEST_PORT}`,
    `AUTH_TRUST_HOST=true`,
    `NEXT_DIST_DIR=.next-test`,
    offline ? 'OFFLINE_MODE=true' : '',
    opts.userId ? `OFFLINE_USER_ID=${opts.userId}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Skip check-deps and check-db for faster startup in tests
  return `${env} npx next dev --port ${TEST_PORT}`;
}

/** Project root directory */
export const PROJECT_ROOT = PROJECT_DIR;

/**
 * Look up a test user by email from test_users.json.
 * Returns the user object or undefined if not found.
 */
export function getTestUser(email: string): { user: string; user_id?: string; password?: string } | undefined {
  const usersFile = path.join(PROJECT_DIR, 'testing', 'test_users.json');
  if (!fs.existsSync(usersFile)) return undefined;
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
  return users.find((u: { user: string }) => u.user === email);
}

/** The first test user (with a user_id) from test_users.json */
export function getFirstTestUser(): { user: string; user_id: string } | undefined {
  const usersFile = path.join(PROJECT_DIR, 'testing', 'test_users.json');
  if (!fs.existsSync(usersFile)) return undefined;
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
  return users.find((u: { user_id?: string }) => u.user_id);
}

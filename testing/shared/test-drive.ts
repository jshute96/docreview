/**
 * Google Drive API client for live tests.
 *
 * Creates an authenticated Drive client using OAuth tokens stored in
 * the test database for the first test user. Useful for programmatically
 * adding/modifying comments in Google Docs during test setup.
 */

import { OAuth2Client } from 'google-auth-library';
import { drive as createDrive } from '@googleapis/drive';
import { getTestDb } from './test-db';
import { readEnvVar, getFirstTestUser } from './test-env';

/**
 * Get an authenticated Drive API client for the first test user.
 * Uses OAuth tokens from the test database Account table.
 */
export async function getTestDriveClient() {
  const testUser = getFirstTestUser();
  if (!testUser) throw new Error('No test user found in test_users.json');

  const db = getTestDb();
  const account = await (db as any).account.findFirst({
    where: {
      user: { email: testUser.user },
      provider: 'google',
    },
  });

  if (!account?.access_token) {
    throw new Error(
      `No Google account found for ${testUser.user} in the test database.\n` +
      'Log in manually first via testing/dev-test.sh + testing/open-browser-live.sh'
    );
  }

  const clientId = readEnvVar('AUTH_GOOGLE_ID');
  const clientSecret = readEnvVar('AUTH_GOOGLE_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set in .env');
  }

  const oauth2Client = new OAuth2Client(clientId, clientSecret);

  oauth2Client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token ?? undefined,
    expiry_date: account.expires_at ? account.expires_at * 1000 : undefined,
  });

  return oauth2Client;
}

/** Create a Drive v3 service instance from an auth client. */
export function createTestDriveService(auth: OAuth2Client) {
  return createDrive({ version: 'v3', auth });
}

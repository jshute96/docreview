/**
 * Lightweight Prisma client for the test database.
 *
 * Used in Playwright tests to verify database state directly.
 * Includes the base64 field-encoding extension (prisma-obscure) so that
 * encoded columns (label names, doc titles/notes) are transparently
 * decoded in query results and encoded in write payloads.
 */

import { PrismaClient } from '@prisma/client';
import { obscureExtension } from '../../src/lib/prisma-obscure';
import { TEST_DATABASE_URL } from './test-env';

// The base64 encoding extension changes the return type, so use the extended type.
type ExtendedClient = ReturnType<typeof makeClient>;

function makeClient() {
  // Override DATABASE_URL so Prisma connects to the test DB, not whatever
  // is in the environment or .env file.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  return new PrismaClient({
    datasources: { db: { url: TEST_DATABASE_URL } },
    log: ['error'],
  }).$extends(obscureExtension);
}

let client: ExtendedClient | undefined;

/** Get (or create) a PrismaClient connected to the test database. */
export function getTestDb() {
  if (!client) {
    client = makeClient();
  }
  return client;
}

/** Disconnect the test database client. Call in afterAll. */
export async function disconnectTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

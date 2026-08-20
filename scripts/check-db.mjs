#!/usr/bin/env node

/**
 * This script checks if the Prisma schema, the generated client, and the
 * database migrations are all in sync.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const USAGE =
  "Check that the Prisma schema, generated client, and database migrations are in sync.\n\n" +
  "Usage:\n" +
  "  node scripts/check-db.mjs\n\n" +
  "Flags:\n" +
  "  --help  Show this help message\n";

const KNOWN_FLAGS = new Set(["--help"]);
const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const unknownFlags = args.filter(a => a.startsWith("-") && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  process.stderr.write(`Unknown flag(s): ${unknownFlags.join(", ")}\n\n${USAGE}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function logError(msg) {
  console.error(`${COLORS.red}${COLORS.bold}Error:${COLORS.reset} ${msg}`);
}

function logSuccess(msg) {
  console.log(`${COLORS.green}✅ ${msg}${COLORS.reset}`);
}

function logWarning(msg) {
  console.warn(`${COLORS.yellow}⚠️  ${msg}${COLORS.reset}`);
}

function runPrismaMigrateStatus() {
  // Merge stderr into stdout so we capture all Prisma output (Prisma
  // sometimes writes status details to stderr rather than stdout).
  const result = execSync(
    'pnpm exec prisma migrate status 2>&1',
    { encoding: 'utf8', shell: true }
  );
  return result;
}

/**
 * Locate the schema.prisma copy that `prisma generate` writes next to the
 * generated client. With a flat node_modules (npm) that is
 * node_modules/.prisma/client; with pnpm the client lives inside the .pnpm
 * store, so resolve @prisma/client and look beside it instead.
 * Returns the path, or null if no generated client was found.
 */
function findGeneratedSchema(rootDir) {
  const candidates = [path.join(rootDir, 'node_modules', '.prisma', 'client', 'schema.prisma')];

  try {
    const require = createRequire(path.join(rootDir, 'package.json'));
    // .../node_modules/@prisma/client/default.js -> .../node_modules
    const clientEntry = require.resolve('@prisma/client');
    const nodeModulesDir = path.resolve(path.dirname(clientEntry), '..', '..');
    candidates.push(path.join(nodeModulesDir, '.prisma', 'client', 'schema.prisma'));
  } catch {
    // @prisma/client isn't installed; treated the same as a missing client.
  }

  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

async function run() {
  let hasError = false;

  console.log(`${COLORS.blue}Checking database and schema sync...${COLORS.reset}`);

  // 1. Check if Prisma Client is in sync with schema.prisma
  const schemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
  const generatedSchemaPath = findGeneratedSchema(rootDir);

  if (!fs.existsSync(schemaPath)) {
    logError('prisma/schema.prisma not found.');
    process.exit(1);
  }

  if (!generatedSchemaPath) {
    logError('Generated Prisma client not found.');
    console.log(`Run: ${COLORS.bold}pnpm exec prisma generate${COLORS.reset}\n`);
    hasError = true;
  } else {
    // Compare content instead of mtime to be more robust (e.g. after git pull)
    const schemaContent = fs.readFileSync(schemaPath, 'utf8').replace(/\s+/g, ' ').trim();
    const generatedContent = fs.readFileSync(generatedSchemaPath, 'utf8').replace(/\s+/g, ' ').trim();

    if (schemaContent !== generatedContent) {
      logError('Prisma client is out of date with schema.prisma.');
      console.log(`Run: ${COLORS.bold}pnpm exec prisma generate${COLORS.reset} and restart your dev server.\n`);
      hasError = true;
    } else {
      logSuccess('Prisma client is in sync with schema.');
    }
  }

  // 2. Check if Database Migrations are in sync
  try {
    const statusRes = runPrismaMigrateStatus();

    if (statusRes.includes('Database schema is up to date')) {
      logSuccess('Database migrations are up to date.');
    } else if (statusRes.includes('not been applied')) {
      logError('Database is OUT OF DATE (missing migrations).');
      console.log(statusRes);
      console.log(`Run: ${COLORS.bold}pnpm exec prisma migrate dev${COLORS.reset}\n`);
      hasError = true;
    } else if (statusRes.includes('not yet been applied') || statusRes.includes('following migration')) {
      logError('Database has pending migrations.');
      console.log(statusRes);
      console.log(`Run: ${COLORS.bold}pnpm exec prisma migrate dev${COLORS.reset}\n`);
      hasError = true;
    } else {
      logWarning('Unexpected output from prisma migrate status:');
      console.log(statusRes);
      hasError = true;
    }

  } catch (e) {
    // prisma migrate status exits non-zero for some mismatch cases —
    // inspect the actual output rather than assuming a connection error.
    // With 2>&1, merged output lands in e.stdout on non-zero exit.
    // Fall back to stderr/message in case shell redirection didn't apply.
    const output = (e.stdout || '') + (e.stderr || '') || e.message || '';

    if (output.includes('not found locally') || output.includes('have been applied to the database but are missing from the local')) {
      logError('Database is AHEAD of this branch (has migrations not found locally).');
      console.log(output);
      console.log(`\nYou may need to ${COLORS.bold}git pull${COLORS.reset} or switch to the branch that created these migrations.\n`);
      hasError = true;
    } else if (output.includes('not been applied') || output.includes('not yet been applied')) {
      logError('Database is OUT OF DATE (missing migrations).');
      console.log(output);
      console.log(`Run: ${COLORS.bold}pnpm exec prisma migrate dev${COLORS.reset}\n`);
      hasError = true;
    } else if (output.includes('P1001') || output.includes('Can\'t reach database') || output.includes('ECONNREFUSED')) {
      logWarning('Could not connect to database (is it running?)');
      console.log(`Check your ${COLORS.bold}.env${COLORS.reset} and DATABASE_URL.\n`);
    } else {
      logWarning('Could not verify database migrations.');
      console.log(output);
      hasError = true;
    }
  }

  if (hasError) {
    process.exit(1);
  }
}

run().catch((err) => {
  logError(err.message ?? 'Unexpected error');
  process.exit(1);
});

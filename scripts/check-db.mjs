#!/usr/bin/env node

/**
 * This script checks if the Prisma schema, the generated client, and the 
 * database migrations are all in sync.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

async function run() {
  let hasError = false;

  console.log(`${COLORS.blue}Checking database and schema sync...${COLORS.reset}`);

  // 1. Check if Prisma Client is in sync with schema.prisma
  const schemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
  const generatedSchemaPath = path.join(rootDir, 'node_modules', '.prisma', 'client', 'schema.prisma');

  if (!fs.existsSync(schemaPath)) {
    logError('prisma/schema.prisma not found.');
    process.exit(1);
  }

  if (!fs.existsSync(generatedSchemaPath)) {
    logError('Generated Prisma client not found.');
    console.log(`Run: ${COLORS.bold}npx prisma generate${COLORS.reset}\n`);
    hasError = true;
  } else {
    // Compare content instead of mtime to be more robust (e.g. after git pull)
    const schemaContent = fs.readFileSync(schemaPath, 'utf8').replace(/\s+/g, ' ').trim();
    const generatedContent = fs.readFileSync(generatedSchemaPath, 'utf8').replace(/\s+/g, ' ').trim();

    if (schemaContent !== generatedContent) {
      logError('Prisma client is out of date with schema.prisma.');
      console.log(`Run: ${COLORS.bold}npx prisma generate${COLORS.reset} and restart your dev server.\n`);
      hasError = true;
    } else {
      logSuccess('Prisma client is in sync with schema.');
    }
  }

  // 2. Check if Database Migrations are in sync
  try {
    // Get local migrations
    const migrationsDir = path.join(rootDir, 'prisma', 'migrations');
    const localMigrations = fs.readdirSync(migrationsDir)
      .filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory())
      .sort();

    // Use prisma migrate status for better env var handling and portability
    const statusRes = execSync(
      'npx prisma migrate status',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    
    if (statusRes.includes('Database schema is up to date')) {
      logSuccess('Database migrations are up to date.');
    } else {
      // If it's not up to date, it will list migrations or show errors.
      // prisma migrate status doesn't return a non-zero exit code for pending migrations,
      // so we parse the text.
      if (statusRes.includes('not been applied')) {
        logError('Database is OUT OF DATE (missing migrations).');
        console.log(statusRes);
        console.log(`Run: ${COLORS.bold}npx prisma migrate dev${COLORS.reset}\n`);
        hasError = true;
      } else if (statusRes.includes('missing locally')) {
        logError('Database is AHEAD of this branch (missing local migrations).');
        console.log(statusRes);
        console.log(`You may need to reset your DB (npx prisma migrate reset) or switch back to the original branch.\n`);
        hasError = true;
      } else {
        logSuccess('Database migrations are up to date.');
      }
    }

  } catch (e) {
    logWarning('Could not verify database migrations (is the database running and initialized?)');
    console.log(`Check your ${COLORS.bold}.env${COLORS.reset} and DATABASE_URL.\n`);
    // Don't fail the whole check if the DB is just offline, as long as the user knows.
  }

  if (hasError) {
    process.exit(1);
  }
}

run();

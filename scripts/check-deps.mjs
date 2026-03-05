#!/usr/bin/env node

/**
 * Quick check that all dependencies from package.json are installed in
 * node_modules.  Runs before the dev server so missing packages are caught
 * early instead of surfacing as confusing runtime errors.
 */

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

const pkgPath = path.join(rootDir, 'package.json');
if (!fs.existsSync(pkgPath)) {
  logError('package.json not found.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

const nodeModulesDir = path.join(rootDir, 'node_modules');
if (!fs.existsSync(nodeModulesDir)) {
  logError('node_modules/ does not exist.');
  console.log(`Run: ${COLORS.bold}npm install${COLORS.reset}\n`);
  process.exit(1);
}

const missing = Object.keys(allDeps).filter((dep) => {
  // Scoped packages like @prisma/client live at node_modules/@prisma/client
  const depDir = path.join(nodeModulesDir, ...dep.split('/'));
  return !fs.existsSync(depDir);
});

if (missing.length > 0) {
  logError(`${missing.length} package(s) missing from node_modules:`);
  for (const dep of missing) {
    console.log(`  - ${dep}`);
  }
  console.log(`\nRun: ${COLORS.bold}npm install${COLORS.reset}\n`);
  process.exit(1);
}

logSuccess('All dependencies installed.');

#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { parseGmailNotification } from "../src/lib/parse-gmail-notification";

const USAGE =
  "Check that saved .json files match what the parser currently produces.\n\n" +
  "Usage:\n" +
  "  npx tsx scripts/check-gmail-notifications.ts            # check all, show diffs\n" +
  "  npx tsx scripts/check-gmail-notifications.ts --update    # update .json files that differ\n\n" +
  "Flags:\n" +
  "  --update  Update .json files to match current parser output\n" +
  "  --help    Show this help message\n";

const KNOWN_FLAGS = new Set(["--update", "--help"]);
const NOTIFICATIONS_DIR = join(__dirname, "../testing/gmail_notifications");

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

const update = args.includes("--update");

const emlFiles = readdirSync(NOTIFICATIONS_DIR).filter(f => f.endsWith(".eml"));
let failures = 0;
let updated = 0;
let passed = 0;
let missing = 0;

for (const file of emlFiles) {
  const name = basename(file, ".eml");
  const emlPath = join(NOTIFICATIONS_DIR, file);
  const jsonPath = join(NOTIFICATIONS_DIR, name + ".json");

  const raw = readFileSync(emlPath, "utf-8");
  const parsed = parseGmailNotification(raw);
  const actual = JSON.stringify(parsed, null, 2) + "\n";

  if (!existsSync(jsonPath)) {
    if (update) {
      writeFileSync(jsonPath, actual);
      process.stderr.write(`  created  ${name}.json\n`);
      updated++;
    } else {
      process.stderr.write(`  missing  ${name}.json (run with --update to create)\n`);
      missing++;
    }
    continue;
  }

  const expected = readFileSync(jsonPath, "utf-8");

  if (actual === expected) {
    process.stderr.write(`  ok       ${name}\n`);
    passed++;
  } else if (update) {
    writeFileSync(jsonPath, actual);
    process.stderr.write(`  updated  ${name}.json\n`);
    updated++;
  } else {
    process.stderr.write(`  DIFFER   ${name}\n`);
    const tmpPath = join(tmpdir(), `${name}.actual.json`);
    writeFileSync(tmpPath, actual);
    try {
      execSync(`diff -u "${jsonPath}" "${tmpPath}"`, { stdio: [null, 2, 2] });
    } catch {
      // diff exits 1 when files differ, which is expected
    }
    failures++;
  }
}

process.stderr.write(`\n${emlFiles.length} files: ${passed} ok`);
if (failures) process.stderr.write(`, ${failures} differ`);
if (missing) process.stderr.write(`, ${missing} missing`);
if (updated) process.stderr.write(`, ${updated} updated`);
process.stderr.write("\n");

if (failures || missing) process.exit(1);

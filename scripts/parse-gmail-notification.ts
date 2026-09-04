#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { parseGmailNotification } from "../src/lib/parse-gmail-notification";

const USAGE =
  "Parse Gmail notification .eml files into structured JSON.\n\n" +
  "Usage:\n" +
  "  npx tsx scripts/parse-gmail-notification.ts <file.eml>          # print JSON to stdout\n" +
  "  npx tsx scripts/parse-gmail-notification.ts <file.eml> --save   # print and save .json alongside .eml\n" +
  "  npx tsx scripts/parse-gmail-notification.ts --all               # regenerate all .json files\n\n" +
  "Flags:\n" +
  "  --save   Save .json file alongside the .eml file\n" +
  "  --all    Regenerate .json for all .eml files in testing/gmail_notifications/\n" +
  "  --help   Show this help message\n";

const KNOWN_FLAGS = new Set(["--save", "--all", "--help"]);
const NOTIFICATIONS_DIR = join(__dirname, "../testing/gmail_notifications");

function parseAndPrint(emlPath: string, save: boolean): void {
  const raw = readFileSync(emlPath, "utf-8");
  const parsed = parseGmailNotification(raw);
  const json = JSON.stringify(parsed, null, 2) + "\n";
  process.stdout.write(json);

  if (save) {
    const jsonPath = emlPath.replace(/\.eml$/, ".json");
    writeFileSync(jsonPath, json);
    process.stderr.write(`Saved ${jsonPath}\n`);
  }
}

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

if (args.includes("--all")) {
  const files = readdirSync(NOTIFICATIONS_DIR).filter(f => f.endsWith(".eml"));
  for (const file of files) {
    const emlPath = join(NOTIFICATIONS_DIR, file);
    const raw = readFileSync(emlPath, "utf-8");
    const parsed = parseGmailNotification(raw);
    const jsonPath = emlPath.replace(/\.eml$/, ".json");
    writeFileSync(jsonPath, JSON.stringify(parsed, null, 2) + "\n");
    process.stderr.write(`Wrote ${basename(jsonPath)}\n`);
  }
} else if (args.length >= 1 && !args[0].startsWith("-")) {
  const save = args.includes("--save");
  parseAndPrint(args[0], save);
} else {
  process.stderr.write(USAGE);
  process.exit(1);
}

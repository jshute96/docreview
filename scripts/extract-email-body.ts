#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";

const USAGE =
  "Extract HTML and/or plaintext body from Gmail notification .eml files.\n\n" +
  "Usage:\n" +
  "  npx tsx scripts/extract-email-body.ts <file.eml>                       # print HTML to stdout\n" +
  "  npx tsx scripts/extract-email-body.ts <file.eml> --text                # print plaintext to stdout\n" +
  "  npx tsx scripts/extract-email-body.ts <file.eml> --html --text         # print both to stdout\n" +
  "  npx tsx scripts/extract-email-body.ts <file.eml> --save                # save .html alongside .eml\n" +
  "  npx tsx scripts/extract-email-body.ts <file.eml> --save --html --text  # save both .html and .txt\n" +
  "  npx tsx scripts/extract-email-body.ts --all                            # save .html for all .eml files\n" +
  "  npx tsx scripts/extract-email-body.ts --all --html --text              # save both for all\n\n" +
  "Flags:\n" +
  "  --html   Extract HTML body (default if --text not specified)\n" +
  "  --text   Extract plaintext body\n" +
  "  --save   Save to file(s) instead of printing to stdout\n" +
  "  --all    Process all .eml files in testing/gmail_notifications/\n" +
  "  --help   Show this help message\n";

const KNOWN_FLAGS = new Set(["--html", "--text", "--save", "--all", "--help"]);
const NOTIFICATIONS_DIR = join(__dirname, "../testing/gmail_notifications");

interface EmailBodies {
  text: string;
  html: string;
}

function extractBodies(raw: string): EmailBodies {
  // Split headers from body at first blank line
  const blankLineMatch = raw.match(/\r?\n\r?\n/);
  if (!blankLineMatch) return { text: "", html: "" };

  const headerSection = raw.substring(0, blankLineMatch.index!);
  const bodySection = raw.substring(blankLineMatch.index! + blankLineMatch[0].length);

  // Find MIME boundary
  const boundaryMatch = headerSection.match(/boundary="([^"]+)"/);
  if (!boundaryMatch) return { text: "", html: "" };

  const boundary = boundaryMatch[1];
  const parts = bodySection.split(`--${boundary}`);

  let textBody = "";
  let htmlBody = "";

  for (const part of parts) {
    const partBlank = part.match(/\r?\n\r?\n/);
    if (!partBlank) continue;
    const partHeaders = part.substring(0, partBlank.index!).toLowerCase();
    const partBody = part.substring(partBlank.index! + partBlank[0].length);

    const isBase64 = partHeaders.includes("base64");
    const isQP = partHeaders.includes("quoted-printable");

    let decoded: string;
    if (isBase64) {
      decoded = Buffer.from(partBody.replace(/\s/g, ""), "base64").toString("utf-8");
    } else if (isQP) {
      const qpDecoded = partBody
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      decoded = Buffer.from(qpDecoded, "latin1").toString("utf-8");
    } else {
      decoded = partBody;
    }

    if (partHeaders.includes("text/plain") && !textBody) {
      textBody = decoded;
    } else if (partHeaders.includes("text/html") && !htmlBody) {
      htmlBody = decoded;
    }
  }

  return { text: textBody, html: htmlBody };
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

const wantText = args.includes("--text");
const wantHtml = args.includes("--html");
const save = args.includes("--save");
const all = args.includes("--all");

// Default to html if neither specified
const doHtml = wantHtml || !wantText;
const doText = wantText;

if (all) {
  const files = readdirSync(NOTIFICATIONS_DIR).filter(f => f.endsWith(".eml"));
  for (const file of files) {
    const emlPath = join(NOTIFICATIONS_DIR, file);
    const name = basename(file, ".eml");
    const bodies = extractBodies(readFileSync(emlPath, "utf-8"));

    if (doHtml) {
      const htmlPath = join(NOTIFICATIONS_DIR, name + ".html");
      writeFileSync(htmlPath, bodies.html);
      process.stderr.write(`Wrote ${name}.html\n`);
    }
    if (doText) {
      const txtPath = join(NOTIFICATIONS_DIR, name + ".txt");
      writeFileSync(txtPath, bodies.text);
      process.stderr.write(`Wrote ${name}.txt\n`);
    }
  }
} else {
  const emlPath = args.find(a => !a.startsWith("-"));
  if (!emlPath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const bodies = extractBodies(readFileSync(emlPath, "utf-8"));

  if (save) {
    if (doHtml) {
      const htmlPath = emlPath.replace(/\.eml$/, ".html");
      writeFileSync(htmlPath, bodies.html);
      process.stderr.write(`Saved ${htmlPath}\n`);
    }
    if (doText) {
      const txtPath = emlPath.replace(/\.eml$/, ".txt");
      writeFileSync(txtPath, bodies.text);
      process.stderr.write(`Saved ${txtPath}\n`);
    }
  } else {
    // Print to stdout
    if (doText && doHtml) {
      process.stdout.write("=== TEXT ===\n");
      process.stdout.write(bodies.text);
      process.stdout.write("\n=== HTML ===\n");
      process.stdout.write(bodies.html);
    } else if (doText) {
      process.stdout.write(bodies.text);
    } else {
      process.stdout.write(bodies.html);
    }
  }
}

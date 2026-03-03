import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import type { WriteStream } from "node:fs";
import { getRequestId } from "./request-context";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// Strip ANSI escape codes for file output
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Format args for file output — use util.inspect for objects/errors, toString for primitives
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  return " " + args.map(a =>
    typeof a === "string" ? a
    : a instanceof Error ? a.stack ?? a.message
    : inspect(a, { depth: 4, colors: false, breakLength: 200 })
  ).join(" ");
}

// --- PST date helpers ---

function pstNow(): Date {
  // Get current time in PST/PDT by formatting in that timezone
  const s = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  return new Date(s);
}

function pstDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pstTimestamp(): string {
  const d = pstNow();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${mi}:${sec}`;
}

// --- Log file management ---

const LOG_DIR = join(process.cwd(), "logs");
const MAX_AGE_DAYS = 14;

let currentStream: WriteStream | null = null;
let currentDateStr = "";
let hasLoggedStart = false;

const PORT = process.env.PORT || "3000";

function logFileName(dateStr: string): string {
  return `docreview-${dateStr}.${PORT}.log`;
}

function ensureStream(): WriteStream | null {
  // Only run file logging on the server
  if (typeof window !== "undefined") return null;

  const today = pstDateString(pstNow());

  if (currentStream && currentDateStr === today) {
    return currentStream;
  }

  // New day or first call — rotate
  if (currentStream) {
    currentStream.end();
  }

  mkdirSync(LOG_DIR, { recursive: true });
  currentDateStr = today;
  const fileName = logFileName(today);
  currentStream = createWriteStream(join(LOG_DIR, fileName), { flags: "a" });
  console.log(`Logging to ${join(LOG_DIR, fileName)}`);

  // Cleanup old log files
  cleanupOldLogs();

  // Log server start on first open (not on daily rotation)
  if (!hasLoggedStart) {
    hasLoggedStart = true;
    writeToFile("INFO ", `[Server] Started on port ${PORT}`, []);
  }

  return currentStream;
}

function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOG_DIR);
    for (const f of files) {
      const match = f.match(/^docreview-(\d{4}-\d{2}-\d{2})\.\d+\.log$/);
      if (match) {
        const fileDate = new Date(match[1] + "T00:00:00");
        if (fileDate.getTime() < cutoff) {
          unlinkSync(join(LOG_DIR, f));
        }
      }
    }
  } catch {
    // Best-effort cleanup — don't let it break logging
  }
}

function writeToFile(level: string, message: string, args: unknown[]) {
  const stream = ensureStream();
  if (!stream) return;

  const ts = pstTimestamp();
  const reqId = getRequestId();
  const cleanMsg = stripAnsi(message);
  const argsStr = formatArgs(args);
  stream.write(`${ts} ${reqId} ${level} ${cleanMsg}${argsStr}\n`);
}

// --- Public API (unchanged signatures) ---

export function logError(message: string, ...args: unknown[]) {
  console.error(`${RED}ERROR: ${message}${RESET}`, ...args);
  writeToFile("ERROR", message, args);
}

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`${YELLOW}WARNING: ${message}${RESET}`, ...args);
  writeToFile("WARN ", message, args);
}

export function logInfo(message: string, ...args: unknown[]) {
  console.log(message, ...args);
  writeToFile("INFO ", message, args);
}

export function logSilent(message: string, ...args: unknown[]) {
  writeToFile("INFO ", message, args);
}

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

const pstFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

interface PstParts { year: string; month: string; day: string; hour: string; minute: string; second: string }

function pstParts(): PstParts {
  const parts = pstFormatter.formatToParts(new Date());
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)!.value;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function pstDateString(): string {
  const { year, month, day } = pstParts();
  return `${year}-${month}-${day}`;
}

function pstTimestamp(): string {
  const { year, month, day, hour, minute, second } = pstParts();
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// --- Log file management ---

const LOG_DIR = join(process.cwd(), "logs");
const MAX_AGE_DAYS = 14;

let currentStream: WriteStream | null = null;
let currentDateStr = "";
let hasLoggedStart = false;

function logFileName(dateStr: string): string {
  return `docreview-${dateStr}.log`;
}

function ensureStream(): WriteStream | null {
  if (typeof window !== "undefined") return null; // no file logging if bundled into a client component (Node fs APIs unavailable)
  if (process.env.NODE_ENV === "test") return null; // no file logging during tests

  const today = pstDateString();

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
    writeToFile("INFO ", "[Server] Started", []);
  }

  return currentStream;
}

function cleanupOldLogs() {
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOG_DIR);
    for (const f of files) {
      const match = f.match(/^docreview-(\d{4}-\d{2}-\d{2})\.log$/);
      if (match) {
        const fileDate = new Date(match[1] + "T00:00:00Z");
        if (fileDate.getTime() < cutoff) {
          unlinkSync(join(LOG_DIR, f));
        }
      }
    }
  } catch {
    // Best-effort cleanup — don't let it break logging
  }
}

function writeToFile(level: string, message: string, args: unknown[], requestId?: string) {
  const stream = ensureStream();
  if (!stream) return;

  const ts = pstTimestamp();
  const reqId = requestId ?? getRequestId();
  const cleanMsg = stripAnsi(message);
  const argsStr = formatArgs(args);
  stream.write(`${ts} ${reqId} ${level} ${cleanMsg}${argsStr}\n`);
}

// --- Public API ---

export function logToFile(filename: string, message: string, ...args: unknown[]) {
  if (typeof window !== "undefined" || process.env.NODE_ENV === "test") return;
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = pstTimestamp();
  const reqId = getRequestId();
  const argsStr = formatArgs(args);
  const stream = createWriteStream(join(LOG_DIR, filename), { flags: "a" });
  stream.write(`${ts} ${reqId} ${message}${argsStr}\n`);
  stream.end();
}

export function logError(message: string, ...args: unknown[]) {
  console.error(`${RED}ERROR: ${message}${RESET}`, ...args);
  writeToFile("ERROR", message, args);
}

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`${YELLOW}WARNING: ${message}${RESET}`, ...args);
  writeToFile("WARN ", message, args);
}

/** Log at info level to console and file. Pass `requestId` to override the
 *  AsyncLocalStorage context (useful when the context may be lost, e.g. Prisma middleware). */
export function logInfo(message: string, ...args: [...unknown[], { _reqId: string }] | unknown[]) {
  // Extract explicit request ID if last arg is { _reqId }
  let requestId: string | undefined;
  if (args.length > 0) {
    const last = args[args.length - 1];
    if (last && typeof last === "object" && "_reqId" in (last as Record<string, unknown>)) {
      requestId = (last as { _reqId: string })._reqId;
      args = args.slice(0, -1);
    }
  }
  if (args.length > 0) {
    console.log(message, ...args);
  } else {
    console.log(message);
  }
  writeToFile("INFO ", message, args, requestId);
}

export function logSilent(message: string, ...args: unknown[]) {
  writeToFile("INFO ", message, args);
}

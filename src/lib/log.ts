const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function logError(message: string, ...args: unknown[]) {
  console.error(`${RED}ERROR: ${message}${RESET}`, ...args);
}

export function logWarning(message: string, ...args: unknown[]) {
  console.warn(`${YELLOW}WARNING: ${message}${RESET}`, ...args);
}

export function logInfo(message: string, ...args: unknown[]) {
  console.log(message, ...args);
}

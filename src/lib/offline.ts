export const OFFLINE_MODE = process.env.OFFLINE_MODE === "true";

// Optional: impersonate an existing DB user by ID.
// Pass as OFFLINE_USER_ID env var or inline: OFFLINE_USER_ID=abc123 npm run dev:offline
export const OFFLINE_USER_ID = process.env.OFFLINE_USER_ID ?? null;

export class OfflineModeError extends Error {
  constructor(operation: string) {
    super(
      `Cannot ${operation}: app is running in offline mode (OFFLINE_MODE=true). ` +
        "Google API calls are disabled."
    );
    this.name = "OfflineModeError";
  }
}

// Fallback identity when no OFFLINE_USER_ID is configured
export const FALLBACK_OFFLINE_USER = {
  id: "offline-user",
  email: "offline@localhost",
  name: "Offline User",
} as const;

export function getExpectedOfflineId() {
  if (!OFFLINE_MODE) return null;
  return OFFLINE_USER_ID ?? FALLBACK_OFFLINE_USER.id;
}

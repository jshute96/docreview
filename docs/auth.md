# Authentication & Token Architecture

## Overview

Docreview uses three layers of credentials, each serving a different purpose:

1. **Session token** — identifies the browser to our app
2. **Access token** — authorizes our app to call Google APIs
3. **Refresh token** — lets our app get new access tokens without user interaction

All three are stored in the database. The browser only ever sees the session token.

## Database Tables

These three tables are managed by NextAuth + PrismaAdapter. They handle identity and credentials — the app's own data (docs, labels, comments) hangs off `users` via foreign keys.

### `users`

The identity table. One row per person, created on first sign-in. All app data belongs to a user.

| Column           | Purpose                                    |
|------------------|--------------------------------------------|
| `id`             | Primary key (cuid)                         |
| `name`           | Display name from Google profile           |
| `email`          | Email from Google profile (unique)         |
| `email_verified` | When email was verified (set by NextAuth)  |
| `image`          | Profile photo URL from Google              |

The user row is permanent — it survives sign-out and re-login. Deleting a user cascades to all their accounts, sessions, docs, labels, etc.

### `accounts`

Links a user to an OAuth provider. Stores the Google API credentials. One row per provider per user (we only use Google, so one row per user).

| Column                | Purpose                                         |
|-----------------------|-------------------------------------------------|
| `id`                  | Primary key                                     |
| `user_id`             | FK to `users`                                   |
| `provider`            | `"google"`                                      |
| `provider_account_id` | Google's unique ID for this user                |
| `access_token`        | Short-lived Google API credential (~1 hour)     |
| `refresh_token`       | Long-lived credential to get new access tokens  |
| `expires_at`          | Unix timestamp when access_token expires         |

Created on first sign-in. Tokens are updated in two places:
- **On sign-in**: `events.signIn` in `src/auth.ts` writes the fresh tokens from the OAuth flow
- **On automatic refresh**: `oauth2Client.on("tokens")` in `src/lib/google-drive.ts` persists new access tokens obtained via the refresh token

### `sessions`

Maps a browser cookie to a user. This is how NextAuth identifies who is making each request — it has nothing to do with Google tokens.

| Column         | Purpose                                    |
|----------------|--------------------------------------------|
| `id`           | Primary key                                |
| `session_token`| Random string; stored as browser cookie    |
| `user_id`      | FK to `users`                              |
| `expires`      | When the session becomes invalid            |

Created on sign-in, deleted on sign-out. Multiple sessions can exist for the same user (e.g., different browsers).

### `verification_tokens`

Used by NextAuth for email-based (passwordless) sign-in. Not currently used — we only support Google OAuth — but the table is required by PrismaAdapter.

## Login Flow

```
Browser                    Next.js                      Google
  |                          |                             |
  |-- Click "Sign in" ------>|                             |
  |                          |-- OAuth redirect ---------->|
  |                          |                             |
  |                          |<-- authorization code ------|
  |                          |                             |
  |                          |-- exchange code for tokens->|
  |                          |<-- access + refresh token --|
  |                          |                             |
  |                          |-- (first login) insert accounts row
  |                          |-- (re-login) update accounts row (*)
  |                          |-- insert sessions row
  |                          |                             |
  |<-- set session cookie ---|                             |
  |-- redirect to /docs ---->|                             |
```

(*) The `events.signIn` hook in `src/auth.ts` handles updating tokens on re-login. Without this, the PrismaAdapter only writes tokens on first `linkAccount` and silently discards fresh tokens on subsequent logins. This was a bug that caused `invalid_grant` errors to persist even after re-login.

## Sign-Out Flow

```
Browser                    Next.js
  |                          |
  |-- POST /api/auth/signout>|
  |                          |-- delete sessions row
  |<-- clear cookie, --------|
  |    redirect to /login    |
```

Sign-out only affects the session. The `accounts` row (with Google tokens) is kept so that the next sign-in can update it in place.

## Token Lifecycle

### Access Token (short-lived, ~1 hour)

- Sent with every Google Drive/Docs API call
- When it expires, the `googleapis` client library automatically uses the refresh token to get a new one
- The `oauth2Client.on("tokens", ...)` handler in `getDriveClient()` (`src/lib/google-drive.ts`) persists refreshed tokens back to the `accounts` table
- No user interaction needed for this refresh — it's invisible

### Refresh Token (long-lived, but can be revoked)

The refresh token becomes invalid when:
- The user revokes access in [Google Account settings](https://myaccount.google.com/permissions)
- The app is in Google Cloud's **"Testing"** publishing status (tokens expire after 7 days)
- The app's OAuth consent screen or scopes change
- Google's security policies revoke it (inactive for 6 months, password change, etc.)

When this happens, all API calls fail with `invalid_grant`. The only fix is for the user to sign out and sign back in, which triggers a fresh OAuth flow and gets new tokens.

### Session Token (configurable, typically 30 days)

- Managed entirely by NextAuth + PrismaAdapter
- No Google interaction
- Expired sessions are harmless (the lookup fails and the user gets redirected to login)
- Stale rows can accumulate if users don't explicitly sign out; these are harmless but could be cleaned up with a periodic `DELETE FROM sessions WHERE expires < NOW()`

## Error Handling Pattern

When a Google API call fails with `invalid_grant`:

1. **Server side** (`src/lib/google-drive.ts`): `invalidGrantResponse()` detects the error and returns a `401` response with a descriptive message
2. **Client side** (`src/lib/api-fetch.ts`): `apiFetch()` intercepts `401` responses and shows a toast telling the user to sign out and sign back in
3. **On re-login** (`src/auth.ts`): The `events.signIn` hook writes fresh tokens to the `accounts` row

Every API route that calls Google wraps its catch block with `invalidGrantResponse()` to convert `invalid_grant` into a consistent `401`. The `apiFetch()` wrapper on the client side ensures a single deduplicated toast (using a fixed toast ID) regardless of how many concurrent API calls fail.

## Key Files

| File | Role |
|------|------|
| `src/auth.ts` | NextAuth config: providers, session strategy, token persistence on sign-in |
| `src/app/api/auth/[...nextauth]/route.ts` | Mounts NextAuth HTTP handlers (GET/POST) |
| `src/app/login/page.tsx` | Login page UI (Google OAuth button, offline mode) |
| `src/lib/google-drive.ts` | `getDriveClient()` reads tokens from DB, auto-refreshes, persists new tokens |
| `src/lib/api-fetch.ts` | Client-side fetch wrapper that handles 401 → reauth toast |
| `prisma/schema.prisma` | `Session`, `Account`, `User` table definitions |

## Offline Mode

When `OFFLINE_MODE` is enabled:
- Uses `CredentialsProvider` instead of Google OAuth (no tokens needed)
- Session strategy switches to `"jwt"` (PrismaAdapter doesn't create DB sessions for credentials-based auth)
- No `accounts` row is created — all Google API calls throw `OfflineModeError`
- The sign-out button is disabled in the UI

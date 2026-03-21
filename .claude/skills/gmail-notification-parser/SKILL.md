---
name: gmail-notification-parser
description: >
  Develop and test the Gmail notification email parser.
  Use when the user asks to check, fix, or update the Gmail notification parser,
  add new notification examples, or work on parsing Gmail comment/sharing emails.
  Also triggers on /gmail-notification-parser.
---

# Gmail Notification Parser

Parse Gmail notification emails (.eml) into structured JSON. The parser is at `src/lib/parse-gmail-notification.ts` and supports comment notifications and sharing invitations.

## Actions

Dispatch based on `$ARGUMENTS`:

- **`check`** (default if no arguments) — Run checks and report results. Don't fix anything.
- **`fix`** — Run checks, fix parser issues, update JSON files, get everything passing.
- **`add`** — Collect new notification examples from Gmail via Playwright.
- **`help`** — Show available actions.

---

## Action: help

Print this summary:

```
/gmail-notification-parser              Run checks and report results
/gmail-notification-parser check        Same as above
/gmail-notification-parser fix          Fix parser issues and get everything passing
/gmail-notification-parser add          Save notification emails from Gmail as new examples
/gmail-notification-parser help         Show this help
```

---

## Action: check

Run the check script and report results. Do NOT fix anything or update files.

### Steps

1. **Run the check script:**
   ```
   ./scripts/check-gmail-notifications.ts
   ```

2. **Run the tests:**
   ```
   npx vitest run src/lib/parse-gmail-notification.test.ts
   ```

3. **Report** the results:
   - How many examples passed/failed/missing
   - How many tests passed/failed
   - If there are failures, show the diffs and suggest running `/gmail-notification-parser fix`

---

## Action: fix

Run checks, fix parser issues, update JSON files, and get everything passing.

### Steps

1. **Run the check script:**
   ```
   ./scripts/check-gmail-notifications.ts
   ```
   This compares saved `.json` files against current parser output using `diff -u`. It also reports any `.eml` files that are missing a `.json` file.

2. **If there are missing `.json` files** (new examples without saved output):
   - Generate the JSON:
     ```
     ./scripts/parse-gmail-notification.ts testing/gmail_notifications/<name>.eml --save
     ```
   - Extract and review the HTML body to verify correctness:
     ```
     ./scripts/extract-email-body.ts testing/gmail_notifications/<name>.eml
     ```
   - Compare the rendered HTML against the JSON output. Check that every piece of visible information is captured. See "Comparing HTML to JSON" below.

3. **If there are diffs** (parser output changed from saved JSON):
   - Review each diff. Determine if the change is correct (parser improvement) or a regression.
   - If correct: accept with `./scripts/check-gmail-notifications.ts --update`
   - If a regression: fix the parser at `src/lib/parse-gmail-notification.ts`

4. **If the parser needs fixes:**
   - Read `src/lib/parse-gmail-notification.ts` to understand the current code.
   - Make targeted fixes. Common issues:
     - New discussion URL types not recognized (e.g., `todo_email_discussion` for assigned comments)
     - `stripTags` losing word boundaries at `<br>` or block tag boundaries
     - Non-breaking spaces (`\u00a0`) not normalized
     - Reply threads on suggestions not extracted
     - New fields not captured (e.g., `assignedTo`)
   - After fixing, re-run the check script to see the new diffs.
   - Review diffs, then accept: `./scripts/check-gmail-notifications.ts --update`

5. **Run the tests:**
   ```
   npx vitest run src/lib/parse-gmail-notification.test.ts
   ```
   - If new features were added, add test cases to the test file.
   - Tests live at `src/lib/parse-gmail-notification.test.ts` and read examples from `testing/gmail_notifications/`.

6. **Report** what changed — new examples added, parser fixes made, tests added/updated.

---

## Action: add

Collect new notification examples from Gmail via Playwright.

### Prerequisites

- A Playwright browser must be open and logged into Gmail for a test user.
- If not already set up, use the `/test-ui` skill to log in first.

### Steps

1. **Navigate to Gmail** (`https://mail.google.com`) in the Playwright browser.

2. **Find the notification email** the user wants to save. It will be from `comments-noreply@docs.google.com` (comment notification) or `drive-shares-dm-noreply@google.com` (sharing invitation).

3. **Download the email:**
   - Open the email.
   - Click the three-dots "More message options" menu.
   - Click "Download message".
   - The `.eml` file saves to `.playwright-mcp/`.

4. **Copy to the examples directory** with a descriptive name:
   ```bash
   cp .playwright-mcp/<downloaded-file>.eml testing/gmail_notifications/<descriptive_name>.eml
   ```
   Naming convention: use snake_case describing the content, e.g.:
   - `comment_notification3` — another comment notification variant
   - `suggestion_with_replies` — suggestion that has reply threads
   - `invitation_to_view` — sharing with view permission
   - `assigned_comment` — comment assigned to the recipient

5. **Generate the JSON:**
   ```
   ./scripts/parse-gmail-notification.ts testing/gmail_notifications/<name>.eml --save
   ```

6. **Verify the output** — compare the JSON against the rendered HTML:
   ```
   ./scripts/extract-email-body.ts testing/gmail_notifications/<name>.eml
   ```
   Review the HTML and check that the JSON captures everything. See "Comparing HTML to JSON" below.

7. **If the parser doesn't handle the new email correctly**, fix it following the fix action workflow.

8. **Run the full check** to make sure nothing else broke:
   ```
   ./scripts/check-gmail-notifications.ts
   ```

9. **Run the tests:**
   ```
   npx vitest run src/lib/parse-gmail-notification.test.ts
   ```
   Consider adding test cases for any new features or email types.

10. **Report** what was added — the example name, what type of notification it is, and any parser changes needed.

---

## Comparing HTML to JSON

This is how to verify the parser captures everything from an email:

1. Extract the HTML body:
   ```
   ./scripts/extract-email-body.ts testing/gmail_notifications/<name>.eml > /tmp/<name>.html
   ```

2. Read the HTML and identify all visible content:
   - Comment threads: quoted text, author, timestamp, comment text, "New" badges
   - Suggestions: action (Delete/Add/Replace), old/new text, author, timestamp
   - Assigned comments: "Assigned to you" labels
   - Mentions: `@email` references in comment text
   - Reply threads on both comments and suggestions
   - Discussion IDs from `disco=` URL parameters
   - Reply-to email addresses from `mailTo:` links

3. Read the JSON file and check each item against the HTML. Look for:
   - Missing discussion sections (new URL types like `todo_email_discussion`)
   - Missing or mangled text (word boundaries lost at HTML tags)
   - Missing fields (assignments, mentions not preserved)
   - Missing reply threads (especially on suggestions)
   - **Parsed dates/times**: Dates and times should be captured in raw and parsed form, like `date_str` and `date`.  If a raw `_str` field exists but the parsed form doesn't, that means parsing that input failed, and the parser needs to be updated.  Also verify the parsed value is correct (e.g., "8:47 AM, Feb 23 (PST)" → "2026-02-23T16:47:00.000Z").

---

## Key files

| File | Purpose |
|------|---------|
| `src/lib/parse-gmail-notification.ts` | The parser — types and parsing logic |
| `src/lib/parse-gmail-notification.test.ts` | Unit tests (vitest) |
| `testing/gmail_notifications/*.eml` | Example emails |
| `testing/gmail_notifications/*.json` | Expected parser output |
| `testing/gmail_notifications/README.md` | Documentation for the examples directory |
| `scripts/parse-gmail-notification.ts` | Parse single .eml to JSON |
| `scripts/check-gmail-notifications.ts` | Check all .json files match parser output |
| `scripts/extract-email-body.ts` | Extract HTML/plaintext body from .eml |

---

## Parser architecture

The parser (`src/lib/parse-gmail-notification.ts`) works as follows:

1. **`parseEmail()`** — splits headers from body, finds MIME boundary, decodes base64/quoted-printable parts, extracts text and HTML bodies.

2. **`parseGmailNotification()`** — dispatches based on the `From:` header:
   - `comments-noreply@docs.google.com` → `parseCommentNotification()`
   - `drive-shares-dm-noreply@google.com` → `parseSharingNotification()`

3. **`parseCommentNotification()`** — extracts document info from schema.org meta tags, then splits the HTML into discussion sections using `ViewAction` meta tags. Each section is classified by its URL:
   - `comment_email_discussion` → comment thread
   - `todo_email_discussion` → assigned comment (also a comment thread)
   - `suggestion_email_discussion` → suggestion with optional reply thread

4. **`parsePostsInSection()`** — finds `<h3>` author headings followed by timestamps and `.notranslate` text divs. Detects "New" badges and extracts avatar URLs.

5. **`stripTags()`** — converts HTML to plain text, replacing `<br>` and block-level closing tags with spaces to preserve word boundaries, normalizing `\u00a0`, and collapsing multiple spaces.

### Output types

- `CommentNotification` — has `comments: CommentThread[]` and `suggestions: Suggestion[]`
- `SharingNotification` — has `sharerName`, `sharerEmail`, `permission`
- Both share common fields: `subject`, `from`, `to`, `date_str`, `date` (ISO 8601, optional), `documentTitle`, `documentUrl`, `documentId`
- `CommentReply` and `Suggestion` have `time_str` (original formatted string) and `time` (ISO 8601, optional — only set when the English-locale format can be parsed)

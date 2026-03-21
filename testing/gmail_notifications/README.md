# Gmail Notification Examples

Sample Gmail notification emails (`.eml`) paired with their parsed JSON output (`.json`). Used to develop and test the notification parser at `src/lib/parse-gmail-notification.ts`.

## Claude Code skill

The `/gmail-notification-parser` skill automates the workflows described here:

- `/gmail-notification-parser check` — run checks and report results
- `/gmail-notification-parser fix` — fix parser issues and get everything passing
- `/gmail-notification-parser add` — save notification emails from Gmail as new examples

See `.claude/skills/gmail-notification-parser/SKILL.md` for the full workflow details.

## Files

Each example has two files:
- `<name>.eml` — raw email downloaded from Gmail
- `<name>.json` — structured data extracted by the parser

Current examples:
- `comment_notification` — comment replies and suggestions on a shared doc
- `comment_notification2` — multiple comment threads, @mentions, assigned comments, suggestion replies
- `assigned_to_me_in_unshared_doc` — assigned comment on an unshared doc
- `mentioned_me_in_unshared_doc` — @mention comment on an unshared doc
- `invitation_to_edit` — sharing invitation with edit permission
- `share_request` — access request from another user

## Adding a new example

1. Download the email from Gmail (three-dots menu → "Download message").
2. Copy the `.eml` file here with a descriptive name.
3. Generate the JSON:
   ```bash
   npx tsx scripts/parse-gmail-notification.ts testing/gmail_notifications/<name>.eml --save
   ```
4. Review the JSON output — check it against the rendered email to verify correctness.

## Scripts

**Parse a single email** — prints JSON to stdout:
```bash
npx tsx scripts/parse-gmail-notification.ts <file.eml>
```

**Parse and save** — prints JSON and writes the `.json` file:
```bash
npx tsx scripts/parse-gmail-notification.ts <file.eml> --save
```

**Regenerate all JSON files** (after parser changes you want to accept):
```bash
npx tsx scripts/parse-gmail-notification.ts --all
```

**Check saved JSON matches current parser output:**
```bash
npx tsx scripts/check-gmail-notifications.ts
```
Shows a diff for any files that don't match. Exits with code 1 if there are differences or missing `.json` files.

**Update saved JSON to match current output:**
```bash
npx tsx scripts/check-gmail-notifications.ts --update
```

**Extract HTML body** — prints to stdout for inspection:
```bash
npx tsx scripts/extract-email-body.ts <file.eml>
```

**Extract plaintext body:**
```bash
npx tsx scripts/extract-email-body.ts <file.eml> --text
```

**Save extracted bodies as files** (`.html` and/or `.txt` alongside the `.eml`):
```bash
npx tsx scripts/extract-email-body.ts <file.eml> --save              # save .html
npx tsx scripts/extract-email-body.ts <file.eml> --save --text       # save .txt
npx tsx scripts/extract-email-body.ts <file.eml> --save --html --text  # save both
npx tsx scripts/extract-email-body.ts --all                           # all .eml → .html
```

## Tests

Unit tests for the parser are in `src/lib/parse-gmail-notification.test.ts`. Run with:
```bash
npx vitest run src/lib/parse-gmail-notification.test.ts
```

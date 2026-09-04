## Documents

Each tracked document has several properties:

- **Role** -- Either *Author* (you wrote it) or *Reviewer* (someone else wrote it). This is set when you add the document and can be changed later.
- **Status** -- Either *Inbox* (needs attention) or *Archived* (reviewed for now). Archived documents automatically return to Inbox when meaningful new activity is detected.
- **Star** -- Flag a document for quick filtering.
- **Labels** -- User-defined tags for organizing documents (e.g., "Project X", "Q1 Review").
- **Notes** -- Free-text notes attached to a document.
- **Access state** -- Normally OK. If a document is trashed, deleted, or you lose access, the row shows a red indicator and the title is struck through. The document stays in your list with all your metadata preserved, and will recover automatically if access is restored.

## Comments and suggestions

**Comments** are discussion threads on a document. Each thread has a top-level comment and zero or more replies.

**Suggestions** are tracked changes (insertions, deletions, edits) proposed through Google Docs' suggestion mode. They appear in the same comment table but have some limitations -- you can't reply to them or navigate directly to them in the document.

## Comment statuses

Each comment thread has its own status, independent of the document's status:

- **Inbox** -- The thread needs your attention. New threads where you're the author, a participant, or were @mentioned start here.
- **Archived** -- You've dealt with this thread. It will return to Inbox if someone else adds a reply or makes a change.
- **Muted** -- You've chosen to ignore this thread. It stays muted even when new replies arrive, *unless* someone @mentions you in a new reply.

## Smart unarchive

When you archive a document or comment, Docreview watches for meaningful new activity and automatically moves it back to Inbox. For documents, this includes new inbox comments, status transitions, or comments resolved by someone else. For comments, new replies from other people trigger unarchive.

Each piece of activity brings the document back once, when Docreview first sees it -- archiving it again sticks until something new happens.

This means you can archive freely without worrying about missing important updates.

## Labels

Labels are colored tags you create to organize documents. Each label has a name, a color, and a position (for ordering). You can filter the document list by label, and apply labels when importing documents or editing them individually or in bulk.

## Tri-state filtering

Most filters in Docreview use a three-state toggle:

- **Off** (default) -- No filtering on this criterion.
- **Include** (highlighted) -- Only show items matching this filter.
- **Exclude** (diagonal strikethrough) -- Hide items matching this filter.

Click a filter to cycle through states. Multiple filters combine with AND logic -- for example, setting Author to "include" and a label to "include" shows only documents where you're the author *and* that have that label.

**Slow-click-to-reset**: If you pause for more than half a second between clicks, an active filter resets to off instead of cycling to the next state. This makes it easy to turn off a filter without cycling through all states.

Launch a background subagent to do a code review.
Pass it a description of what this change is supposed to do.
The subagent should:

1. Run `git diff HEAD` to see all unstaged/staged changes (or `git diff HEAD~1` if already committed).
2. Read any files needed for full context around the changed lines.
3. Review the changes against CLAUDE.md project conventions.
4. Generate a unique filename using the current timestamp: `tmp/code-review-$(date +%s).md`
5. Write its full review to that file using the Write tool. The review should include:
   - Summary of what changed
   - Any bugs, logic errors, or missing edge cases
   - Style or convention issues
   - Anything that looks unintentional (leftover debug code, missing files, etc.)
6. Return a one-line summary like "Review written to <filename> — found N issues"

While the review agent runs in the background, also do your own review:
- Check if any docs in `docs/*.md` or elsewhere need updating for this change.
- Update docs if necessary.

$ARGUMENTS

Do NOT poll, sleep, or check on the background agent — you will be automatically notified when it finishes.
Once notified, read its output file with the Read tool and surface anything we should fix.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `yamhochi/trip-agent-mcp`, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context; the glossary is `CONTEXT.md`, ADRs are in `docs/adr/`. See `docs/agents/domain.md`.

## Working agreements

### Tech debt

Known limits and code-review findings that are deliberately left unfixed are tracked in one place: the "Tech debt from code review" issue, #32 (label `tech-debt`).

After finishing each ticket, once its code review is done:

1. Check what was found and left unfixed: review findings you chose not to fix, known limits, and any place the work deviates from the ticket's wording.
2. Add each one to #32 as a checklist item (`- [ ] ...`) under the heading that fits, with a link to the PR or ticket it came from. Add a new heading if none fits. Edit the issue body; don't post a comment.
3. Don't fix tech debt inside an unrelated ticket unless the maintainer asks. When an item is fixed later, tick it and link the fix.

Mention in the ticket's final report which items were added.

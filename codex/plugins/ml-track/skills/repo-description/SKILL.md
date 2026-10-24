---
name: repo-description
description: Set or inspect the default booking description for every Codex conversation in this repository.
---

# ML Track repo description (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

The repo description is the DEFAULT for every conversation in this repository that sets none of its own with the `description` skill. A booking uses the conversation's own description when it is set and not just whitespace; otherwise this repo default; otherwise none. It lives in the repo's binding file, `.moonlabs/tracking/codex-config.json` (the file the `project` skill writes; the Claude build's `config.json` has its own, independent value). That file is meant to be committed, so the repo description is shared with everyone working in this repository — say so whenever it is set or cleared.

- No text from the user: run description --repo --show, plus --session <id> when the thread id is known. Change nothing. Report `repoDescription` (or that none is set) and which description bookings use (`effectiveDescription`, `descriptionSource`).
- Only --clear: run description --repo --clear (plus --session <id>).
- Text: run description --repo --set <text> (plus --session <id>). An empty text is refused rather than taken as a clear; clearing a shared value takes --clear.

After a set or clear, report `configFile` — the binding file that was written (found upward from the working directory, or created there if the repo had none) — and remind the user to commit it if the team should book with the same default. If `descriptionSource` is `session`, add that this conversation keeps booking with its own description until it is cleared.

Every response carries `tracking`. If it is `false`, say so plainly and first: this repository books NOTHING right now, so the description will not reach the tracker until track --on is run (or the turns are booked later with backfill).

The hook re-measures every turn of a conversation each time it runs and requeues any turn whose booking changed, so a changed repo description also reaches the earlier turns of each conversation that relies on it, as corrections, the next time that conversation's hook runs.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

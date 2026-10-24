---
name: status
description: Show ml-track login, project, tracking state, and booked Codex turns.
---

# ML Track status (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Run status, adding --session <id> when the current Codex thread id is available. Summarize loggedIn, credentialsIssue, project, enabled, the descriptions, and booked/pending counts. For the descriptions, show this conversation's (`description`), the repo default (`repoDescription`), and the one bookings carry (`effectiveDescription`, from `descriptionSource`: `session`, `repo`, or `none`); point at the `description` skill for the conversation's own and the `repo-description` skill for the repo default. A missing Codex login requires a separate Codex agent token.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

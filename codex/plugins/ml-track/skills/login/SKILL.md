---
name: login
description: Log ml-track into the MoonLabs tracker with a Codex agent token.
---

# ML Track login (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Run login --token <provided-token> --url <provided-base-url>. Obtain missing token and URL from the user. Never print tokens or reuse Claude credentials. Confirm the returned agent identity; an agent-scoped token is required for booking.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

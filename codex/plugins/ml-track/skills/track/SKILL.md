---
name: track
description: Enable, disable, or inspect automatic ml-track booking for Codex in this repo.
---

# ML Track track (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Run track to inspect, track --on to enable, or track --off to disable as requested. Confirm the client/project and enabled state. Automatic hooks must be trusted via /hooks in the Codex CLI.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

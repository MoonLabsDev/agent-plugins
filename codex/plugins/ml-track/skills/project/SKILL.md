---
name: project
description: Bind this repository to a MoonLabs client project for Codex tracking.
---

# ML Track project (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Run project --list, show clients and projects, and use the user-selected project id with project --set <id>. Confirm both client and project from the response. Configuration is .moonlabs/tracking/codex-config.json, found from the repository root or any subdirectory of it.

The response carries `tracking`. A fresh binding turns tracking on: every completed turn is booked from now on, with no second step. A repository that was already bound keeps whatever it had, so a deliberate track --off survives a re-bind. Report the state from `tracking`, never from assumption. If it is `false`, say so plainly and first: this repository books NOTHING until track --on is run — a bound repo that books nothing looks exactly like a working one until someone checks the tracker.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

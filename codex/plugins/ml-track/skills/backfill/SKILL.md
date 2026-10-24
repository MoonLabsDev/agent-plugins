---
name: backfill
description: Preview and book previously completed turns from this Codex conversation.
---

# ML Track backfill (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Resolve the current session id. Confirm the description (description --session <id> --show; change only when requested). The preview's `descriptionSource` says where it came from: `session`, `repo` (the repo default from the `repo-description` skill, used because this conversation has none), `flag` (an explicit --description) or `none`. Run backfill --session <id> (optional --transcript <path>). Show groups, total time and tokens per bucket (`totals`), the models, the description, and missing subagent data. The preview has no cost: the tracker prices the tokens with its own model prices (Instanz → KI-Preise) when it books them. Get explicit approval for this concrete preview before running backfill --commit --plan <returned-planFile>. Never book from a freshly regenerated plan after approval.

The tracker allows 120 requests a minute per token, so committing a large plan waits out each rate limit and continues by itself; it can run for several minutes — let it finish, do not re-run it. Report booked and failed from the response. If the response still carries `rateLimited: true`, the plan is NOT fully booked: say how many turns are in `remaining` and that running the same --commit --plan again later continues where it stopped.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

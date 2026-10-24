---
name: description
description: Set or inspect the booking description for this Codex conversation.
---

# ML Track description (Codex)

Resolve the plugin root as two directories above this SKILL.md directory. Run Node with the absolute path to bin/ml-track.mjs in that root, with the repository as working directory. All arguments must be separate, correctly shell-quoted values; never interpolate untrusted input into shell code.

Use description --session <id> --show to inspect, --set <text> to set the supplied text, or --clear to clear it. Never invent a session id. With no text from the user, run --show — never --set with an empty value, which silently wipes the description.

This is the CONVERSATION's description. The repository can also carry a default, set with the `repo-description` skill. A booking uses this conversation's description when it is set and not just whitespace; otherwise the repo default; otherwise none. Every response reports `description` (this conversation's), `repoDescription`, and `effectiveDescription` with `descriptionSource` (`session`, `repo` or `none`). Say which one bookings actually use; after a clear, say that bookings fall back to the repo default if one is set.

The hook re-measures every turn of the conversation each time it runs and requeues any turn whose booking changed, so a changed description (this one or the repo default) reaches this conversation's earlier turns too, as corrections, at the next hook. Say so if the user expects only future turns to change.

Every response carries `tracking`. If it is `false`, say so plainly and first: this repository books NOTHING right now, so the description will not reach the tracker until track --on is run (or the turns are booked later with backfill). Do not let a successful set read as "this conversation is being tracked" — that misreading is how whole sessions went unbooked.

Commands return JSON. Report errors from ok:false and do not claim a failed operation succeeded. Session-dependent verbs need the current Codex thread id: use CODEX_THREAD_ID if available, or the task's known id; never guess from the latest session file. To discover a supplied id's rollout, the CLI searches CODEX_HOME/sessions and archived_sessions.

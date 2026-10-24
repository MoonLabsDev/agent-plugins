---
description: Analyse this conversation and book its unbooked turns after confirmation
---

Run the dry run first — it books nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" backfill --session "${CLAUDE_SESSION_ID}"
```

The result's `groups` array is what will ACTUALLY be booked — the server
coalesces turns into fewer time records (same project, not billable, within
the agent's merge gap, same calendar day), and a preview of raw turns would
misrepresent what the user is confirming. `groups` is already coalesced for
you; never re-derive the merge rule from the turns yourself.

## Render exactly two tables

**Table 1 — one row per entry in `groups`:** date, from, to, real working
time, main-thread tokens (`inputTokens + outputTokens + cacheReadTokens +
cacheWriteTokens`), subagent tokens (`subagentUsageTokens`). All times in
**Europe/Berlin**, computed from each group's `startedAt`/`endedAt`.
`activeSeconds` is the real working time.

A record groups by its START day, so a record that begins at 23:58 can
legitimately END after midnight — e.g. a row reading `02:43 -> 00:02`. That
is correct, not a bug: only the START of each merged turn has to fall on the
record's own day, never the end. Do not "fix" such a row.

**Table 2 — one row per token bucket, from `totals`:** cache read
(`cacheReadTokens`), cache write (`cacheWriteTokens`), output
(`outputTokens`), input (`inputTokens`), subagents (`subagentUsageTokens`) and
a total row. There is no cost column, on purpose: the tracker prices the
tokens with its own model prices (Instanz → KI-Preise) when it books them, so
any figure shown here could only disagree with what gets booked. Name the
models (`models`) below the table.

## If `mergeGapKnown` is `false`

The plugin could not confirm the agent's real merge gap (not logged in yet,
or the server was unreachable) — `groups` therefore has one row per turn,
UNGROUPED, because a guessed gap could produce a wrong preview. Say this
plainly before the tables: the rows below may not match the final booked
records exactly, since the server may coalesce some of them once the real
gap is known. Do not present the ungrouped rows as if they were confirmed
final records.

## Confirm the description FIRST, on its own

The dry run's `description` is what every one of these records will be filed
under. `descriptionSource` says where it came from: `session` (this
conversation's own), `repo` (the repo default from
`/ml-track:repo-description`, used because this conversation has none),
`flag` (passed explicitly), or `none`. It is easy for it to be empty, or to be
left over from what this conversation was about an hour ago.
It is also the only part of the booking a human reading the tracker later
actually sees.

Show it back verbatim and ask, as its own question, whether the user really
wants these records booked under it:

- if it is a non-empty string, quote it exactly
- if it is empty, say so plainly — these records will carry NO description,
  which in the tracker's lists shows as a blank row

Say where it came from, and how to change it: set a new one for this
conversation with `/ml-track:description <text>` (or the repo default with
`/ml-track:repo-description <text>`) and then re-run the dry run. Do not offer to
book first and rename afterwards — the server may coalesce several of these
into one record, and the descriptions are joined when it does, so a later
edit is not a clean rename.

Only once the description is settled, go on to the rest.

## Before asking for confirmation, say plainly

- how many records will be booked, to which client and project
- that they will be booked as **not billable**, for a human to flag later
- that every record carries this conversation's own id (`sessionId`), so
  another conversation running in the same project books its own records
  rather than merging into these
- that the tracker prices the tokens when it books them; a model it has no
  price for books its tokens at zero cost until an instance admin adds the
  price on the KI-Preise page and recomputes
- if `totals.subagentUsageTokens` is above zero, that the subagents' tokens are
  booked too, each under the subagent's own model
- if `subagentDataAvailable` is `false`, say plainly that subagent transcript
  data was **not available** for this session (it lives under the OS temp
  directory, which is not durable, and may have been cleared since the
  session ran) — the booked usage may understate real spend, and this is
  different from "no subagents ran"

Ask the user to confirm. **Only if they agree**, book exactly what was shown:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" backfill --commit --plan "<planFile from the dry run>"
```

Report how many were booked and how many failed. If the result carries
`locked: true`, `booked` and `failed` are both `0` — this does **not** mean
nothing happened. It means another flush was already running when this one
tried to start, so nothing was sent yet on this attempt. Tell the user their
entries are spooled and confirmed, and that the already-running flush (or the
next one) will send them shortly — do not report it as a failure or ask them
to retry.

Do not re-run the dry run before committing — the plan file is what makes
"what you saw is what was written" true. The `--commit` step always books
from the individual turns already recorded in the plan file, exactly as
before; grouping only changes what the CONFIRMATION shows, never what the
server does with the plan.

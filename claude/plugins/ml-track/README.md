# ml-track

`ml-track` is a Claude Code plugin that books the time and the token cost of
an agent's work onto a MoonLabs time-tracker project, automatically, as each
turn finishes. It reads only Claude Code's own transcript files and speaks
only to `/api/v1` — it never touches the tracker's database directly.

## Installation

`ml-track` lives inside this repository, at `plugin/claude/ml-track/`, so
tracking work in *any* repo requires a checkout of **this** repo somewhere on
the machine.

1. Register this repo as a plugin marketplace and install from it. The repo
   root carries `.claude-plugin/marketplace.json`, which is what makes the
   path below a valid marketplace source — `add` takes a filesystem path, so
   no git remote is needed:

   ```bash
   claude plugin marketplace add /path/to/time-tracker
   claude plugin install ml-track@moonlabs
   ```

   Restart Claude Code afterwards. The seven `/ml-track:*` commands below then
   become available and the Stop hook is registered — but it is inert
   everywhere until you opt a repo in (step 3).
2. Run `/ml-track:login <token> [--url <base>]` once per machine. This
   validates the token against `GET /me` and stores it in
   `~/.moonlabs/tracking/claude/credentials.json`. Use an **agent-scoped** token —
   `/ml-track:login` tells you plainly if the token it validated is not one,
   because the server rejects both `active_seconds` and `costs` from a
   non-agent credential: a non-agent token creates no record at all, not a
   record with no cost.
3. In each repository you want tracked, run `/ml-track:project` to pick a
   client/project and bind this repo to it. A fresh binding turns automatic
   booking on; `/ml-track:track off` (and `on`) switches it for that repo.

From then on, every completed turn in that repo is booked automatically, in
the background, with no further action needed.

### Updating after you edit the plugin

Claude Code **copies** a marketplace plugin into `~/.claude/plugins/cache/`
at install time, and `claude plugin update` decides whether there is anything
to fetch by comparing the `version` in `.claude-plugin/plugin.json`. Editing a
source file without bumping that version leaves the cached copy in place while
`update` still reports success — the change simply never arrives. Use the
bundled script, which bumps, validates and updates in the right order:

```bash
node plugin/claude/ml-track/update.mjs
```

`--minor` / `--major` / `--set 1.2.3` choose the bump, `--dry-run` shows what
would happen, `--no-install` stops after the bump. Restart Claude Code when it
finishes: the cached copy is read at startup, so a running session keeps the
old one.

To iterate without installing anything, load the plugin for one session
instead — changes to command `.md` files are live, and `/reload-plugins`
picks up hook changes:

```bash
claude --plugin-dir /path/to/time-tracker/plugin/claude/ml-track
```

## Commands

| Command | What it does |
| --- | --- |
| `/ml-track:login <token> [--url <base>]` | Validates the token against the API and stores it for this machine. Reports the company, user, agent identity and scopes it authenticated as. |
| `/ml-track:project` | Lists your clients and active projects and binds this repository to the one you choose. Re-run any time to change it. |
| `/ml-track:track [on\|off]` | Turns automatic per-turn booking on or off for this repo. With no argument, reports the current state. |
| `/ml-track:description [<text>\|--clear]` | Shows, sets or clears this conversation's own description. Empty by default; overrides the repo default while set. |
| `/ml-track:repo-description [<text>\|--clear]` | Shows, sets or clears the repo-wide default description, used by every conversation in this repo that sets none of its own. Stored in the committed binding file, so it is shared with everyone working in the repo. |
| `/ml-track:backfill` | Analyses the current conversation for turns not yet booked, shows a table and a total cost, and books them only after you confirm. |
| `/ml-track:status` | Shows what's configured (login, client, project, tracking on/off), the conversation, repo and effective descriptions, pending vs. booked turn counts, and the pricing table version. |

### Which description a booking carries

The conversation's own description (`/ml-track:description`) when it is set
and not just whitespace; otherwise the repo default
(`/ml-track:repo-description`); otherwise none. The Stop hook, the backfill dry
run and `status` all resolve it the same way (`lib/description.mjs`);
`backfill --description <text>` overrides both. The typical use: every
internal repo is bound to the same project with a fixed repo description set
once, and a conversation that is about something specific sets its own.

The description is resolved when a turn is spooled. Turns already spooled keep
the description they were spooled with, so changing either one affects only
turns booked from then on.

Behind the command, the CLI form is `description --repo --show`,
`description --repo --set <text>` and `description --repo --clear`; the set
refuses an empty text, so a shared value is only ever removed by `--clear`.

Every command is a thin wrapper around the bundled CLI
(`bin/ml-track.mjs`) — it shells out and renders the CLI's JSON. None of
them re-implement logic the CLI owns.

## Where files live

| File | Scope | Commit it? |
| --- | --- | --- |
| `~/.moonlabs/tracking/claude/credentials.json` | Per machine AND per host (one login covers every repo; a future Codex build gets its own, since the tracker takes the agent from the credential) | **No** — it holds your API token. Written with owner-only permissions. |
| `<repo>/.moonlabs/tracking/config.json` | Per-repo (client, project, `enabled`, the repo default `description`) | **Yes** — it holds no secret, so a whole team can book to the same project by committing this file. The repo description travels with it: everyone working in the repo books under it unless their conversation sets its own. |
| `~/.moonlabs/tracking/claude/spool/<sessionId>.*` | Per-session (the pending/booked ledger, the sticky description, the transcript read offset) | No — local, transient bookkeeping. |

`MOONLABS_TRACKING_TOKEN` and `MOONLABS_TRACKING_URL` override the
credentials file, for CI or a machine where you don't want a token on disk.

## Limitations

**Every record is booked `billable: false`, on purpose.** A human reviews the
agent's work afterward and flags it billable if appropriate. This is safe
either way: the server stamps the rate that applied *at the moment the work
happened* when the record is created, regardless of the billable flag, so
flipping the flag later prices the work correctly — not at today's rate.

**Subagent token usage is not priced.** When a turn launches a subagent
(an `Agent` tool call, or a `SendMessage` call that resumes one — both count
identically), its completion carries a total token count with no
model attribution, so there is nothing to look up a rate for. The turn's
*time* is still correct — the parent turn's wall clock already covers however
long the subagent ran — only its *cost* is understated. On a measured
session this gap was bounded between roughly 0.3% and 7% of the session's
main-thread cost, depending on which price the subagent tokens would have
carried. `/ml-track:backfill` reports the omitted subagent token count so
the gap is visible rather than silent, instead of guessing a model and
fabricating a precision the data doesn't have.

**An unpriced model books time but zero cost.** If a turn uses a model that
isn't in `pricing-table.json`, `active_seconds` is still booked correctly,
but that model's `cost_micros` comes back `0` — the model name is kept, not
dropped or replaced. A `/ml-track:backfill` dry run surfaces it under
`unpricedModels`, so a gap in the table shows up instead of silently
underbilling.

**The server's idempotency protection is not permanent.** It keys on
`(company_id, token_id, key)` with a 24h TTL, so `<sessionId>:<turnUuid>`
stops deduplicating a retry after 24 hours or after the token is re-minted.
The local ledger under `~/.moonlabs/tracking/claude/spool/` is the only *durable*
dedupe, and it is per-machine: if it is lost (a new machine, a cleaned home
directory) and you then backfill a session that was live-booked more than a
day earlier, every turn in it is inserted a second time — doubled hours and
cost on that project.

This plugin computes what an agent's work *would have cost at API list
price*. It is not an invoice, and it applies no discount, contract rate, or
markup — treat the figure as a cost-of-delivery estimate, not a bill.

### Adding a model to the pricing table

Edit `pricing-table.json` — that's the only file involved. Add an entry
under `"models"` keyed by the model name exactly as it appears in the
transcript's `message.model` field, with five rates, each in **USD per
million tokens**:

```jsonc
"claude-some-new-model": {
  "input": 3.0,        // input tokens
  "output": 15.0,       // output tokens
  "cacheRead": 0.3,     // cache-read tokens
  "cacheWrite5m": 3.75, // cache-write tokens, 5-minute TTL
  "cacheWrite1h": 6.0   // cache-write tokens, 1-hour TTL
}
```

Bump the top-level `"version"` field so `/ml-track:status`'s reported
pricing table version changes along with it. No code change or restart is
needed — `lib/pricing.mjs` reads `pricing-table.json` fresh on load, and
turns already booked keep the rate that applied when they were priced;
nothing is retroactively repriced.

A row with a missing or non-numeric field in any of the five rates is
silently dropped from the loaded table entirely, so that model then prices
as unknown — the same as a model absent altogether — rather than throwing
or charging a zero rate for just that one field.

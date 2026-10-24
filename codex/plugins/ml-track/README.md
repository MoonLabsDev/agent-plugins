# ML Track for Codex

Native Codex port of `plugin/claude/ml-track` (source snapshot 0.4.0).
The Claude package remains independent. The bundled API, spool, retry,
payload, grouping and CLI logic retain the Claude implementation's contract.
Codex-specific code is in `lib/paths.mjs`, `lib/transcript.mjs`, the skills
and hooks. Port shared fixes deliberately to both packages.

## Install

From the time-tracker repository:

```powershell
codex plugin marketplace add ./plugin/codex
codex plugin add ml-track@moonlabs-codex
```

Start a new Codex task after installation. Select the ml-track `status`,
`login`, `project`, `track`, `description`, `repo-description`, or `backfill`
skill, or ask for it by name. The skills resolve their own installed CLI location.

Automatic booking also requires reviewing and trusting the plugin hooks with
`/hooks` in the Codex CLI. Installing a plugin does not grant hook trust.
See https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks.

Log in with a **Codex agent-scoped tracker token**, then choose a project with
the `project` skill to bind the repository. A fresh binding turns automatic
booking on; the `track` skill switches it off (and on) for that repo, and a
re-bind keeps whatever was last chosen. A bound repo whose tracking is off
books nothing — `project`, `description`, `track` and `status` all report
`tracking`, and the skills say so plainly when it is `false`. Never reuse the
Claude agent token: the server attributes bookings according to the token.
Login and spool live in `~/.moonlabs/tracking/codex/`; repo opt-in is
`.moonlabs/tracking/codex-config.json`, independent of Claude tracking. It is
looked up from the working directory upwards, so a hook or skill run from a
subdirectory finds the repo's one config; the search stops at the first
directory with a `.git`, so a different repository nested inside a bound one
never inherits its binding.
`MOONLABS_TRACKING_TOKEN` and `MOONLABS_TRACKING_URL` are supported overrides.

A booking's description is the conversation's own (`description` skill) when
it is set and not just whitespace; otherwise the repo default
(`repo-description` skill, CLI `description --repo --show|--set <text>|--clear`);
otherwise none. The repo default is stored in `codex-config.json` beside the
binding, so it is shared with everyone working in the repo once that file is
committed, and it is independent of the Claude build's `config.json`. The hook,
backfill and `status` all resolve it through `lib/description.mjs`; an
explicit `backfill --description` overrides both. Because the hook re-measures
every turn of a conversation and requeues changed payloads, a changed
description also reaches that conversation's earlier turns as corrections —
unlike the Claude build, where spooled turns keep the description they were
spooled with.

## Tracking semantics and limitations

- Requires server migration `0014` for permanent turn identity. Each request
  names `session_id` and `turn_id`; the server scopes identity to company,
  user and agent, independent of access token and the HTTP retry cache.
  Repeated turns replace their measured time/usage; late turns regroup in
  chronological order using the agent's merge gap and day boundaries.
  Active time excludes gaps, and costs are counted once per source turn.
- Backfill skips unchanged booked turns and previews changed measurements as
  corrections. Those preview totals describe submitted measurements, not the
  net change to the server total. Hooks can also correct earlier measurements.
  Deleted records are not automatically resurrected.
- Bookings made before turn identity was introduced stay intact. Locally
  acknowledged legacy turns remain skipped; overlaps with unidentified old
  server aggregates return `record.legacy_turn_overlap` and remain pending.
  Such historical data needs explicit reconciliation from a complete source;
  a wider time span alone cannot establish which costs/work it contains.

- Parses Codex JSONL rollouts using task_started/task_complete and turn ids.
  Interrupted turns with turn_aborted also qualify. Unfinished turns do not.
  A Stop event can close its own turn before task_complete is persisted.
- Counts token_usage_record usage once per response id, falling back to
  cumulative token_count deltas for older rollouts. Cached input and cache
  writes are separated from input; reasoning output is already part of output.
- Time sums timestamp gaps up to the repo idle threshold (default 120s).
  Recognized request_user_input calls exclude time until their result.
  Longer gaps are excluded conservatively; long uninterrupted computation can
  therefore be undercounted. Async questions wrapped in exec cannot be reliably
  identified from these rollouts.
- Subagent usage is not collected in this version; backfill explicitly reports
  subagentDataAvailable=false. Costs are main-thread estimates.
- Bookings carry times and token counts only, per model: input, output,
  cached input, cache writes (as the short write, the only one the rollout
  reports) and, from `token_usage_record`, each response's own usage. The
  tracker prices them with its model prices (Instanz → KI-Preise) when it
  stores the booking, including long context (above 272K prompt tokens for
  the OpenAI models that list it), which applies per response. Older rollouts
  that only carry cumulative `token_count` deltas do not reveal one request's
  prompt size; their turns are priced at the short-context rates, which can
  understate a long-context request. A model the tracker has no price for is
  booked with its tokens at zero cost and recomputed once an instance admin
  adds the price. Fast mode, regional, tool and subscription charges are not
  modeled.
- Hook transcript paths are preferred; backfill can discover JSONL rollouts in
  CODEX_HOME/sessions or archived_sessions, or accept --transcript explicitly.
  Non-JSONL/paginated storage is not supported; transcript formats may change.
- Bookings are non-billable, retain session ids, and use the durable local
  spool plus API idempotency. Preserve the spool to avoid historical duplicates.
- Backfill previews first and commits only the user-approved plan.
- The tracker allows 120 requests a minute per token. A flush stops at the
  first HTTP 429 without recording a failed attempt against any entry; the
  unsent turns stay pending for the next flush. `backfill --commit` waits the
  server's `Retry-After` (60s if absent) plus one second and continues, for at
  most 60 rounds, then reports summed totals — with `rateLimited: true` and
  `remaining` only if the plan is still not fully booked.

## Verification and updates

```powershell
node --test plugin/codex/plugins/ml-track/test/*.test.mjs
node plugin/codex/plugins/ml-track/bin/ml-track.mjs status
```

After editing, update the manifest's Codex cachebuster using the Codex
plugin-creator helper, reinstall `ml-track@moonlabs-codex`, and start a new task.
Changed hooks need renewed trust through `/hooks`.

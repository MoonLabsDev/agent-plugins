#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { readCredentials, writeCredentials, readRepoConfig, writeRepoConfig, credentialsIssue } from '../lib/config.mjs'
import { createClient } from '../lib/api.mjs'
import { readEntries } from '../lib/spool.mjs'
import { effectiveDescription } from '../lib/description.mjs'
import { transcriptPath, migrateLegacyLayout, subagentTasksDir } from '../lib/paths.mjs'
// TABLE_VERSION is intentionally NOT imported here. lib/pricing.mjs reads and
// parses pricing-table.json at import time — a static top-level import of it
// would run that read for every verb, including `hook`, before the hook
// verb's own try/catch is even entered. A missing or corrupt table would
// then crash the whole process outright: uncaught exception, non-zero exit,
// a stack trace on stderr, in direct violation of "a hook must never disrupt
// a turn". Only the `status` verb needs TABLE_VERSION, so it loads
// lib/pricing.mjs itself, lazily, inside its own guarded path below. (The
// hook verb's own indirect use of pricing, through buildPayload, already
// goes through a dynamic import inside its try block — that one was already
// correct and is unchanged.)

/**
 * One JSON object on stdout, always. The slash commands render it; a human
 * never reads this directly, so a stable machine shape beats pretty output.
 */
const emit = (value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }

/**
 * ApiError.body is the server's raw response, and a misbehaving server can
 * echo request headers — including `Authorization: Bearer <token>` — straight
 * back into it (flagged by the api.mjs review). fail() writes to stdout,
 * which the slash command renders and which can end up quoted in a report a
 * human reads, so a response body never reaches it here: call sites below
 * pass only a status code and a hand-written message, and `body` is stripped
 * from `extra` defensively in case a future call site passes one anyway.
 */

/**
 * A sentinel, not a real error: thrown by fail() purely to unwind the call
 * stack back to the try/catch around the verb dispatch below, which
 * swallows exactly this class and nothing else. See fail()'s own comment
 * for why it no longer calls process.exit(1) directly.
 */
class CliFailure extends Error {}

/**
 * fail() used to call process.exit(1) right after writing to stdout.
 * Node's stdout is asynchronous for pipes on POSIX (notably macOS) —
 * process.exit() truncates whatever of that write has not flushed yet, so a
 * Mac user's slash command could see EMPTY stdout: no JSON to branch on,
 * exactly the contract break graded Important here. Setting
 * process.exitCode and throwing instead of exiting lets the process end
 * naturally once the event loop drains — Node's own documented
 * recommendation over calling exit() directly — so the write always
 * completes. The throw still has to stop execution at the call site
 * immediately: every fail() call site in this file was checked, and none
 * has code after it that a resumed execution would need to skip, because
 * the throw unwinds past all of them uniformly, up to the one try/catch
 * around the dispatch below.
 */
const fail = (message, extra = {}) => {
  const { body: _droppedBody, ...safeExtra } = extra
  emit({ ok: false, error: message, ...safeExtra })
  process.exitCode = 1
  throw new CliFailure(message)
}

const argOf = (argv, name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/**
 * The description fields `status` and `description` both report: the
 * conversation's own (`description`, null without a session — the field kept
 * its pre-repo-scope meaning), the repo default, and which of them a booking
 * made now would carry.
 */
const describe = (sessionId, cwd) => {
  const { session, repo, effective, source } = effectiveDescription({ sessionId, cwd })
  return {
    description: sessionId ? session : null,
    repoDescription: repo, effectiveDescription: effective, descriptionSource: source,
  }
}

const [verb, ...argv] = process.argv.slice(2)

try {
  // Before ANY verb reads state: an install predating the per-host namespace
  // keeps its credentials and spool one directory up, and without this the
  // user would appear logged out and have to hand over their token again.
  // Inside the try so a failure here becomes the normal ok:false JSON rather
  // than a stack trace on stdout.
  migrateLegacyLayout()

  if (verb === 'login') {
    const token = argOf(argv, '--token')
    const baseUrl = argOf(argv, '--url') ?? 'http://localhost:3000'
    if (!token) fail('missing --token')
    const api = createClient({ baseUrl, token })
    let me
    try {
      me = await api.getMe()
    } catch (error) {
      // error.message is either ApiError's default `${status} from ${url}` or
      // a network error's own message — neither ever carries the token or a
      // response body. error.status is a plain integer (or absent).
      // baseUrl travels as its own field, not folded into the message: a
      // network failure's message is bare ("fetch failed") and names no URL
      // at all, which is precisely the case where the user needs to see which
      // URL was tried — a wrong --url and a stopped server look identical
      // otherwise. An HTTP failure's message already carries the full URL, so
      // this stays a separate field rather than being concatenated twice.
      fail(`login failed: ${error.message}`, { status: error.status ?? null, baseUrl })
    }
    writeCredentials({ baseUrl, token })
    emit({ ok: true, user: me.user, company: me.company, role: me.role, scopes: me.scopes, agent: me.agent ?? null })
  } else if (verb === 'project') {
    const creds = readCredentials()
    if (!creds) fail('not logged in — run /ml-track:login first')
    const api = createClient(creds)
    if (argv.includes('--list')) {
      let clients, projects
      try {
        ;[clients, projects] = await Promise.all([api.listClients(), api.listProjects()])
      } catch (error) {
        // Same shape as login's guard: error.message never carries the token
        // or a response body (see fail()'s comment above), so it's safe to
        // pass straight through along with the status where one is available.
        fail(`failed to list clients/projects: ${error.message}`, { status: error.status ?? null })
      }
      emit({ ok: true, clients, projects })
    } else {
      const projectId = argOf(argv, '--set')
      if (!projectId) fail('missing --set <projectId>')
      let projects
      try {
        projects = await api.listProjects()
      } catch (error) {
        fail(`failed to list projects: ${error.message}`, { status: error.status ?? null })
      }
      const project = projects.find((p) => p.id === projectId)
      if (!project) fail(`no active project with id ${projectId}`)
      let clients
      try {
        clients = await api.listClients()
      } catch (error) {
        fail(`failed to list clients: ${error.message}`, { status: error.status ?? null })
      }
      const client = clients.find((c) => c.id === project.client?.id) ?? null
      const existing = readRepoConfig(process.cwd()) ?? {}
      writeRepoConfig(process.cwd(), {
        // Spread first so keys the binding does not own — the repo-wide
        // `description` — survive a re-bind.
        ...existing,
        client: client ? { id: client.id, name: client.name } : null,
        project: { id: project.id, name: project.name },
        // A fresh binding books. Binding has no other purpose, and "bound but
        // off until a second command" left repos silently unbooked for weeks;
        // an existing config keeps whatever was last chosen, so re-binding
        // never undoes an explicit `track --off`.
        enabled: existing.enabled ?? true,
        idleThresholdSeconds: existing.idleThresholdSeconds ?? 120,
      })
      emit({
        ok: true, project: { id: project.id, name: project.name }, client,
        tracking: Boolean(readRepoConfig(process.cwd())?.enabled),
      })
    }
  } else if (verb === 'status') {
    const creds = readCredentials()
    const cfg = readRepoConfig(process.cwd())
    const sessionId = argOf(argv, '--session')
    const entries = sessionId ? readEntries(sessionId) : []
    // Loaded lazily and guarded: a missing/corrupt pricing-table.json must
    // degrade `status`'s own pricingTable field to null, not crash the verb
    // and violate the CLI's "one JSON object on stdout, always" contract.
    let pricingTable = null
    try {
      ;({ TABLE_VERSION: pricingTable } = await import('../lib/pricing.mjs'))
    } catch {
      pricingTable = null
    }
    emit({
      ok: true,
      loggedIn: creds !== null,
      // readCredentials() collapses "nothing configured" and "a token with no
      // base URL" into the same null (see lib/config.mjs). credentialsIssue()
      // tells the two apart so a logged-out user gets told which one applies,
      // instead of a bare "not logged in" that would mislead the second case.
      // Only computed when creds is null — when creds is non-null there is no
      // issue to report, by construction.
      credentialsIssue: creds === null ? credentialsIssue() : null,
      baseUrl: creds?.baseUrl ?? null,
      tracking: Boolean(cfg?.enabled),
      client: cfg?.client ?? null,
      project: cfg?.project ?? null,
      sessionId: sessionId ?? null,
      ...describe(sessionId, process.cwd()),
      pending: entries.filter((e) => e.status === 'pending').length,
      booked: entries.filter((e) => e.status === 'booked').length,
      pricingTable,
    })
  } else if (verb === 'track') {
    const cfg = readRepoConfig(process.cwd())
    if (!cfg) fail('this repository is not bound to a project — run /ml-track:project first')
    if (argv.includes('--on') || argv.includes('--off')) {
      cfg.enabled = argv.includes('--on')
      writeRepoConfig(process.cwd(), cfg)
    }
    emit({ ok: true, tracking: cfg.enabled, project: cfg.project, client: cfg.client })
  } else if (verb === 'description') {
    // Two scopes. The CONVERSATION's description is keyed by session id
    // (`spool.readDescription`/`writeDescription`): one project hosts many
    // sessions, each with its own. `--repo` addresses the repo-wide default in
    // the binding file instead, used by every conversation that sets none.
    // Bookings resolve the two through lib/description.mjs.
    const { writeDescription } = await import('../lib/spool.mjs')
    const { writeRepoDescription, repoConfigPath } = await import('../lib/config.mjs')
    const cwd = process.cwd()
    const sessionId = argOf(argv, '--session')
    // A description is only ever USED by a booking. `tracking` rides along so
    // the skill can say, at the moment it matters, that this repo books
    // nothing — setting one into a repo with tracking off otherwise succeeds
    // quietly and reads as "this conversation is being tracked".
    const report = (extra = {}) => emit({
      ok: true, sessionId: sessionId ?? null, ...describe(sessionId, cwd),
      tracking: Boolean(readRepoConfig(cwd)?.enabled), ...extra,
    })
    if (argv.includes('--repo')) {
      if (argv.includes('--show')) {
        report({ scope: 'repo' })
      } else if (argv.includes('--clear')) {
        writeRepoDescription(cwd, '')
        report({ scope: 'repo', configFile: repoConfigPath(cwd) })
      } else {
        // The slash command passes its arguments through whole (numbered
        // placeholders resolve one word late there), so the text arrives as
        // `--repo <text>`; the leading flag is not part of the description.
        const text = (argOf(argv, '--set') ?? '').replace(/^\s*--repo(\s+|$)/, '')
        // Unlike the session form, an empty set is refused rather than taken
        // as a clear: this value is shared with everyone in the repo, so
        // wiping it takes the explicit --clear.
        if (text.trim() === '') fail('no description text — use --show to see the repo description, or --clear to remove it')
        writeRepoDescription(cwd, text)
        report({ scope: 'repo', configFile: repoConfigPath(cwd) })
      }
    } else {
      // Without --session there is no conversation to read or write, which
      // is why this fails rather than falling back to the repo default.
      if (!sessionId) fail('missing --session')
      // --show exists so that INVOKING the command with no text can report
      // the current description instead of destroying it. Without it the only
      // reachable no-argument behaviour is `--set ""`, i.e. a silent clear —
      // the opposite of what someone typing the bare command expects.
      if (!argv.includes('--show')) {
        writeDescription(sessionId, argv.includes('--clear') ? '' : (argOf(argv, '--set') ?? ''))
      }
      report({ scope: 'session' })
    }
  } else if (verb === 'hook') {
    // A hook must NEVER disrupt a turn: every failure path here exits 0 in
    // silence. The worst case is a turn that is not booked, which the next
    // flush or /ml-track:backfill recovers.
    try {
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const cwd = payload.cwd ?? process.cwd()
      const cfg = readRepoConfig(cwd)
      if (!cfg?.enabled || !cfg.project?.id) process.exit(0)

      const { readFileSync, statSync, existsSync, readdirSync } = await import('node:fs')
      if (!payload.transcript_path || !existsSync(payload.transcript_path)) process.exit(0)

      const { parseTurns } = await import('../lib/transcript.mjs')
      const { buildPayload, idempotencyKeyFor } = await import('../lib/payload.mjs')
      const spool = await import('../lib/spool.mjs')
      const { join } = await import('node:path')

      // Best-effort: a missing/unreadable subagent tasks directory (see
      // subagentTasksDir's own doc comment — it lives under the OS temp
      // directory and is not durable) just means this turn's cost is
      // main-only, same as a session with no subagents at all. A hook must
      // never disrupt a turn over this, so any fs error here is swallowed by
      // the outer try/catch, not handled specially.
      let subagentTexts = []
      const tasksDir = subagentTasksDir(cwd, payload.session_id)
      if (existsSync(tasksDir)) {
        subagentTexts = readdirSync(tasksDir)
          .filter((f) => f.endsWith('.output'))
          .map((f) => readFileSync(join(tasksDir, f), 'utf8'))
      }

      const text = readFileSync(payload.transcript_path, 'utf8')
      const turns = parseTurns(text, { idleThresholdSeconds: cfg.idleThresholdSeconds ?? 120, subagentTexts, completedTurnId: payload.hook_event_name === 'Stop' ? payload.turn_id : undefined })
      // Resolved on every hook run, for every turn in the rollout: unlike the
      // Claude build, appendPending here requeues a turn whose payload
      // changed, so a changed description reaches this session's earlier
      // turns as corrections (see skills/description/SKILL.md).
      const { effective: description } = effectiveDescription({ sessionId: payload.session_id, cwd })
      for (const turn of turns) {
        spool.appendPending(payload.session_id, {
          turnUuid: turn.turnUuid,
          idempotencyKey: idempotencyKeyFor(payload.session_id, turn),
          payload: buildPayload(turn, {
            projectId: cfg.project.id,
            description,
            sessionId: payload.session_id,
          }),
        })
      }
      spool.writeOffset(payload.session_id, statSync(payload.transcript_path).size)

      // Spooling is local and needs no credentials — a turn is recorded
      // pending even while logged out, and the next flush (once credentials
      // exist) picks it up. Only the flush itself needs credentials, so a
      // missing login just skips spawning it here rather than skipping the
      // spool: there is nothing to send yet, and spawning a flusher that would
      // immediately fail with "not logged in" gains nothing.
      //
      // Detached so a stopped server or a VPN blip cannot stall the end of a
      // turn. The flusher takes the lock; a second one exits immediately.
      if (readCredentials()) {
        const { spawn } = await import('node:child_process')
        const self = fileURLToPath(import.meta.url)
        const child = spawn(process.execPath, [self, 'flush', '--session', payload.session_id], {
          detached: true, stdio: 'ignore', windowsHide: true,
        })
        // A failed launch leaves pending entries for the next flush.
        child.on('error', () => {})
        child.unref()
      }
    } catch {
      // A hook must never disrupt a turn; pending entries can be recovered.
    }
    process.exit(0)
  } else if (verb === 'flush') {
    const sessionId = argOf(argv, '--session')
    if (!sessionId) fail('missing --session')
    const creds = readCredentials()
    if (!creds) fail('not logged in')
    const { flushSession } = await import('../lib/flush.mjs')
    emit({ ok: true, ...(await flushSession(sessionId, createClient(creds))) })
  } else if (verb === 'backfill') {
    const cfg = readRepoConfig(process.cwd())
    if (!cfg?.project?.id) fail('this repository is not bound to a project — run /ml-track:project first')
    const spool = await import('../lib/spool.mjs')
    const { join } = await import('node:path')
    const { readFileSync, writeFileSync, existsSync, readdirSync } = await import('node:fs')

    if (argv.includes('--commit')) {
      const planFile = argOf(argv, '--plan')
      if (!planFile) fail('missing --plan <file>')
      // Books from the PLAN FILE, never from a re-parse: what is written must be
      // exactly what the user was shown and approved. A missing, truncated or
      // hand-edited plan file must still leave the CLI's one-JSON-object-on-
      // stdout contract intact, so this never throws past emit().
      let plan
      try {
        plan = JSON.parse(readFileSync(planFile, 'utf8'))
      } catch (error) {
        fail(`could not read plan file at ${planFile} — re-run the dry run to regenerate it (${error.message})`)
      }

      // JSON.parse succeeding only proves the file is syntactically valid JSON
      // — `{}` parses fine and is exactly what a careless hand-edit produces,
      // but `for (const entry of plan.entries)` below would throw a bare
      // TypeError on it ("plan.entries is not iterable"), past emit(), with a
      // stack trace and no JSON on stdout. Validate the SHAPE the commit path
      // actually reads before using any of it: `entries` must be an array, and
      // every entry must carry the fields appendPending/flushSession read
      // (`turnUuid`, `idempotencyKey`, a `payload` object) — a missing or
      // malformed `payload` is the same class of bug as `{}` itself.
      if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
        fail(`plan file at ${planFile} is not a JSON object — re-run the dry run to regenerate it`)
      }
      if (!Array.isArray(plan.entries)) {
        fail(`plan file at ${planFile} has no "entries" array — re-run the dry run to regenerate it`)
      }
      for (const [index, entry] of plan.entries.entries()) {
        const entryOk = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && typeof entry.turnUuid === 'string' && entry.turnUuid !== ''
          && typeof entry.idempotencyKey === 'string' && entry.idempotencyKey !== ''
          && entry.payload !== null && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
        if (!entryOk) {
          fail(`plan file at ${planFile} has a malformed entry at index ${index} — re-run the dry run to regenerate it`)
        }
      }

      // plan.sessionId is the last piece of SHAPE the type checks above cannot
      // cover: it throws inside assertSafeSessionId rather than failing a
      // typeof test. Validating it HERE, with the other shape checks, is what
      // lets everything below share one error label. The earlier split-catch
      // attempt put it in its own try around the appendPending loop — but
      // appendPending calls ensureDir(), so an fs error (a spool path that is
      // a plain file, say) surfaced from that same loop and was relabelled
      // "plan file is malformed", sending the user to re-run a dry run that
      // could never fix it. That is exactly the bug the split was meant to
      // stop, and only an empty-entries plan avoided it.
      if (typeof plan.sessionId !== 'string') {
        fail(`plan file at ${planFile} has no "sessionId" string — re-run the dry run to regenerate it`)
      }
      try {
        spool.assertSafeSessionId(plan.sessionId)
      } catch (error) {
        fail(`plan file at ${planFile} has an unusable sessionId (${error.message}) — re-run the dry run to regenerate it`)
      }

      const creds = readCredentials()
      if (!creds) fail('not logged in')
      // One catch for the whole booking: past the shape checks, anything that
      // throws is an fs, lock or network failure, never the plan's shape.
      try {
        for (const entry of plan.entries) {
          spool.appendPending(plan.sessionId, entry)
        }
        const { flushSession } = await import('../lib/flush.mjs')
        // Restrict the flush to exactly the plan's own turns — flushSession
        // otherwise sends every pending entry for the session, which would sweep
        // in turns the live Stop hook spooled while the user was reading the
        // confirmation table. See flushSession's `restrictTo` doc comment.
        const turnUuids = plan.entries.map((entry) => entry.turnUuid)
        // A plan is routinely larger than the tracker's per-minute budget, so
        // a rate-limited flush is waited out and continued rather than
        // reported as done with most of the plan unsent. Bounded, so a server
        // that answers 429 forever ends in an honest `rateLimited: true`
        // instead of a command that never returns. The lock is released
        // between rounds (flushSession's own finally), so a live Stop hook's
        // flusher is never starved while this one sleeps.
        const api = createClient(creds)
        const total = { booked: 0, failed: 0, errors: [] }
        let last
        for (let round = 0; round < 60; round += 1) {
          last = await flushSession(plan.sessionId, api, turnUuids)
          total.booked += last.booked
          total.failed += last.failed
          total.errors.push(...last.errors)
          if (!last.rateLimited) break
          await new Promise((r) => setTimeout(r, ((last.retryAfterSeconds ?? 60) + 1) * 1000))
        }
        emit({
          ok: true, ...total,
          ...(last.locked ? { locked: true } : {}),
          ...(last.rateLimited ? { rateLimited: true, remaining: last.remaining } : {}),
        })
      } catch (error) {
        fail(`failed to book plan file at ${planFile}: ${error.message}`)
      }
    } else {
      const sessionId = argOf(argv, '--session')
      if (!sessionId) fail('missing --session')
      // --transcript is an explicit override (and how the tests drive this
      // parser); when absent, derive Claude Code's own transcript location
      // instead of failing, since Claude Code has no ${CLAUDE_TRANSCRIPT_PATH}
      // variable to substitute (C1) — commands/backfill.md no longer passes one.
      let transcript = argOf(argv, '--transcript')
      if (!transcript) {
        transcript = transcriptPath(process.cwd(), sessionId)
        if (!existsSync(transcript)) fail(`could not find a transcript at ${transcript}`)
      }
      const { parseTurns } = await import('../lib/transcript.mjs')
      const { buildPayload, idempotencyKeyFor } = await import('../lib/payload.mjs')
      const { priceUsage } = await import('../lib/pricing.mjs')

      // The durability problem (this task's brief): `tasks/` lives under the
      // OS temp directory, not durably like ~/.claude/projects — a backfill
      // run weeks later may find it gone. Booking $0 of subagent cost then
      // would look exactly like "no subagents ran", silently understating
      // the bill. `subagentDataAvailable` tells the two apart: false means
      // the directory itself is missing (data may be lost), true means it
      // was checked — even if it turned out empty (no subagents this
      // session, a real zero).
      let subagentDataAvailable = false
      let subagentTexts = []
      const tasksDir = subagentTasksDir(process.cwd(), sessionId)
      if (existsSync(tasksDir)) {
        subagentDataAvailable = true
        subagentTexts = readdirSync(tasksDir)
          .filter((f) => f.endsWith('.output'))
          .map((f) => readFileSync(join(tasksDir, f), 'utf8'))
      }

      // An explicit --description wins over everything; otherwise the same
      // resolution the Stop hook applies.
      const resolved = effectiveDescription({ sessionId, cwd: process.cwd() })
      const description = argOf(argv, '--description') ?? resolved.effective
      const descriptionSource = argOf(argv, '--description') === undefined ? resolved.source : 'flag'
      const booked = new Map(spool.readEntries(sessionId).filter((e) => e.status === 'booked').map((e) => [e.turnUuid, e]))
      const turns = parseTurns(readFileSync(transcript, 'utf8'), {
        idleThresholdSeconds: cfg.idleThresholdSeconds ?? 120,
        subagentTexts,
      }).filter((t) => {
        const prior = booked.get(t.turnUuid)
        if (!prior) return true
        if (!prior.payload.turn_id) return false
        return JSON.stringify(prior.payload) !== JSON.stringify(buildPayload(t, { projectId: cfg.project.id, description, sessionId }))
      })

      const entries = turns.map((turn) => ({
        turnUuid: turn.turnUuid,
        idempotencyKey: idempotencyKeyFor(sessionId, turn),
        payload: buildPayload(turn, { projectId: cfg.project.id, description, sessionId }),
      }))
      const planFile = join(spool.spoolRoot(), `backfill-${sessionId}.json`)
      writeFileSync(planFile, JSON.stringify({ sessionId, entries }, null, 2) + '\n', 'utf8')

      const unpriced = new Set()
      let spanSeconds = 0
      let activeSeconds = 0
      for (const turn of turns) {
        spanSeconds += turn.spanSeconds
        activeSeconds += turn.activeSeconds
        for (const bucket of turn.usage) {
          const priced = priceUsage(bucket)
          if (priced.unpriced) unpriced.add(priced.model)
        }
      }

      // The merge gap is per-agent, stored server-side only
      // (agents.merge_gap_seconds), and can change after login — a cached
      // copy would silently produce a wrong preview the moment an operator
      // edits it. So it is fetched LIVE, here, the one place it is actually
      // used, and never persisted to disk. Best-effort: not logged in, or a
      // network/API failure, means the real gap cannot be confirmed — the
      // dry run must say so (mergeGapKnown: false), never guess.
      // mergeGapSeconds: 0 is a real, known value (coalescing off for this
      // agent, same as the server's own rule) and must stay distinguishable
      // from "unknown".
      let mergeGapSeconds = null
      let mergeGapKnown = false
      const creds = readCredentials()
      if (creds) {
        try {
          const me = await createClient(creds).getMe()
          if (me.agent && Number.isFinite(me.agent.mergeGapSeconds)) {
            mergeGapSeconds = me.agent.mergeGapSeconds
            mergeGapKnown = true
          }
        } catch {
          // Network/API failure — mergeGapKnown stays false, never a guess.
        }
      }

      const { groupTurns } = await import('../lib/groups.mjs')
      const groups = groupTurns(turns, mergeGapKnown ? mergeGapSeconds : NaN)

      let costMicros = 0
      let subagentCostMicros = 0
      let inputCostMicros = 0
      let outputCostMicros = 0
      let cacheReadCostMicros = 0
      let cacheWriteCostMicros = 0
      for (const g of groups) {
        costMicros += g.mainCostMicros + g.subagentCostMicros
        subagentCostMicros += g.subagentCostMicros
        inputCostMicros += g.inputCostMicros
        outputCostMicros += g.outputCostMicros
        cacheReadCostMicros += g.cacheReadCostMicros
        cacheWriteCostMicros += g.cacheWriteCostMicros
      }

      emit({
        ok: true, planFile, sessionId, project: cfg.project, client: cfg.client, description, descriptionSource,
        turns: turns.map((t) => ({
          turnUuid: t.turnUuid, startedAt: t.startedAt, endedAt: t.endedAt,
          spanSeconds: t.spanSeconds, activeSeconds: t.activeSeconds,
          models: t.usage.map((u) => u.model),
        })),
        // One row per record the server would ACTUALLY book (coalesced), not
        // one per turn — see lib/groups.mjs. Structured, not pre-rendered:
        // commands/backfill.md formats it, but must never re-derive the
        // merge rule itself.
        groups: groups.map(({ startedAt, endedAt, activeSeconds: groupActiveSeconds, mainCostMicros, subagentCostMicros: groupSubagentCostMicros }) => ({
          startedAt, endedAt, activeSeconds: groupActiveSeconds, mainCostMicros, subagentCostMicros: groupSubagentCostMicros,
        })),
        mergeGapSeconds, mergeGapKnown,
        totals: {
          turns: turns.length, spanSeconds, activeSeconds, costMicros, subagentCostMicros,
          inputCostMicros, outputCostMicros, cacheReadCostMicros, cacheWriteCostMicros,
        },
        unpricedModels: [...unpriced],
        subagentDataAvailable,
      })
    }
  } else {
    fail(`unknown verb: ${verb ?? '(none)'}`)
  }
} catch (error) {
  if (!(error instanceof CliFailure)) throw error
}

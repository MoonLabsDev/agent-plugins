/**
 * THE ONE HOST-SPECIFIC MODULE (spec P2).
 *
 * Everything here knows Claude Code's JSONL transcript format; nothing else in
 * this plugin does. A plugin/codex/ml-track reimplements exactly this file and
 * reuses the rest unchanged, which is why `parseTurns` returns plain data with
 * no Claude-shaped names in it.
 *
 * Every rule below was measured against a real 16,198-line transcript. The
 * counts that justified them are in the spec's §6.
 */

/**
 * Tools whose result arrives only when a HUMAN answers. The gap between the
 * call and its result is waiting, not work, and is excluded no matter how long
 * — one measured AskUserQuestion wait ran 25 minutes.
 */
export const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

const toMs = (iso) => Date.parse(iso)

/**
 * A REAL user prompt, as opposed to the many other things that carry
 * `type: "user"`. Measured over 600 lines: 17 real prompts against 90 tool
 * results and 1 meta entry.
 *
 * `toolUseResult` and `sourceToolUseID` are top-level markers on entries the
 * harness synthesised; `isMeta` marks injected context. An entry whose content
 * array holds a `tool_result` block is a tool response, not a prompt — this is
 * the case that matters most, since it is the commonest non-prompt by far.
 *
 * `isCompactSummary` / `isVisibleInTranscriptOnly` mark an injected
 * continuation message — the "session is being continued from a previous
 * conversation that ran out of context" summary the harness writes back into
 * the transcript as a plain-string `type: "user"` entry. It carries neither
 * `toolUseResult` nor `sourceToolUseID` nor an array content, so none of the
 * other checks catch it; on the reference transcript this admitted 2 of them
 * as spurious turn starts out of 213.
 */
function isRealPrompt(entry) {
  if (entry.type !== 'user') return false
  if (entry.isMeta) return false
  if ('toolUseResult' in entry) return false
  if (entry.sourceToolUseID) return false
  if (entry.isCompactSummary) return false
  if (entry.isVisibleInTranscriptOnly) return false
  const content = entry.message?.content
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return false
  return true
}

const contentBlocks = (entry) => {
  const c = entry.message?.content
  return Array.isArray(c) ? c : []
}

/**
 * Interactive-wait windows, as `[callMs, answerMs]` intervals — one per
 * AskUserQuestion/ExitPlanMode call that was actually answered.
 *
 * The previous implementation stored the exclusion as a
 * `"${callTimestamp}->${answerTimestamp}"` key and matched it only against
 * the gap between two *adjacent* entries. That works only when nothing lands
 * between the call and its answer. The natural interloper is a task
 * notification — exactly the "interactive wait while a subagent is
 * outstanding" case (spec §6) — which splits one gap into two, neither of
 * which equals the stored key, so both fall through to the generic
 * idle-threshold check and (if short enough) the whole human-wait reads as
 * active. Timestamps are also not unique on a real transcript (408
 * duplicates measured on the reference file), so a timestamp pair was never
 * a reliable identifier for a specific gap to begin with.
 *
 * An interval fixes both problems at once: any gap `[fromMs, toMs]` that
 * falls entirely inside `[callMs, answerMs]` is part of the wait, no matter
 * how many entries (or duplicate timestamps) subdivide it.
 */
function interactiveIntervals(entries) {
  const openCallMs = new Map() // tool_use id -> call timestamp (ms)
  const intervals = []
  for (const entry of entries) {
    if (entry.type === 'assistant') {
      for (const block of contentBlocks(entry)) {
        if (block?.type === 'tool_use' && INTERACTIVE_TOOLS.has(block.name)) {
          openCallMs.set(block.id, toMs(entry.timestamp))
        }
      }
    }
    if (entry.type === 'user') {
      for (const block of contentBlocks(entry)) {
        if (block?.type === 'tool_result' && openCallMs.has(block.tool_use_id)) {
          intervals.push([openCallMs.get(block.tool_use_id), toMs(entry.timestamp)])
          openCallMs.delete(block.tool_use_id)
        }
      }
    }
  }
  return intervals
}

/** Whether the gap `[fromMs, toMs]` falls entirely inside an interactive wait. */
function isInteractiveGap(intervals, fromMs, toMsValue) {
  return intervals.some(([start, end]) => fromMs >= start && toMsValue <= end)
}

/**
 * Usage buckets for one assistant entry, keyed by `model|effort|origin`.
 * `origin` ('main' vs 'subagent') is folded into the key, not just the
 * bucket's own field, so a main-thread and a subagent turn on the SAME
 * model/effort never merge into one bucket — that would silently blend a
 * subagent's spend into the main thread's and defeat the whole point of
 * marking it separately (this task's brief: "marked as coming from a
 * subagent").
 */
function accumulateUsage(map, entry, origin = 'main') {
  const message = entry.message ?? {}
  const model = message.model
  // `<synthetic>` entries carry no real usage and must never reach the pricer.
  if (!model || model === '<synthetic>') return
  const usage = message.usage ?? {}
  const creation = usage.cache_creation ?? {}
  const effort = entry.effort ?? 'none'
  const key = `${model}|${effort}|${origin}`
  const bucket = map.get(key) ?? {
    model, effort, origin,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    requests: [],
  }
  // One assistant entry is one API request, so its usage is that request's
  // own: kept beside the sums because a long-context price applies per
  // request, by the size of that request's prompt (priced by the server).
  const request = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: creation.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1hTokens: creation.ephemeral_1h_input_tokens ?? 0,
  }
  bucket.inputTokens += request.inputTokens
  bucket.outputTokens += request.outputTokens
  bucket.cacheReadTokens += request.cacheReadTokens
  bucket.cacheWrite5mTokens += request.cacheWrite5mTokens
  bucket.cacheWrite1hTokens += request.cacheWrite1hTokens
  bucket.requests.push(request)
  map.set(key, bucket)
}

/**
 * Parses one subagent `.output` transcript's raw JSONL text into
 * usage-bearing entries, paired with the parsed timestamp (ms) that
 * attribution below matches against a parent turn's window. Mirrors the
 * main-transcript rules that matter here: only `type: "assistant"` entries
 * carry usage, `<synthetic>` carries none, and a malformed/missing
 * timestamp drops the entry rather than admitting a NaN that could poison
 * attribution (same reasoning as the main parse loop in `parseTurns`).
 */
function parseSubagentEntries(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type !== 'assistant') continue
    const model = parsed.message?.model
    if (!model || model === '<synthetic>') continue
    const ms = parsed.timestamp ? toMs(parsed.timestamp) : NaN
    if (!Number.isFinite(ms)) continue
    out.push({ ms, entry: parsed })
  }
  return out
}

/**
 * The parent turn whose `[startedAtMs, endedAtMs]` window contains `ms`, or
 * -1 if none does. `bounds` must be sorted ascending by `startMs` (true here
 * because turns are built in chronological order of `starts`) so this is a
 * binary search rather than a linear scan.
 *
 * Measured on a real session (this task's brief): every one of 1106 subagent
 * entries fell inside exactly one turn — zero before the first, zero after
 * the last, zero in a gap, because turns are contiguous. `-1` is still
 * handled explicitly (not asserted-unreachable) so a transcript that breaks
 * that guarantee drops the entry instead of crashing or double-counting it.
 */
function findContainingTurn(bounds, ms) {
  let lo = 0
  let hi = bounds.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bounds[mid].startMs <= ms) lo = mid + 1
    else hi = mid
  }
  const idx = lo - 1
  if (idx < 0) return -1
  if (ms > bounds[idx].endMs) return -1
  return idx
}

const SUBAGENT_TOKENS = /<subagent_tokens>(\d+)<\/subagent_tokens>/g
const TASK_ID = /<task-id>([^<]+)<\/task-id>/
const TOOL_USE_ID_TAG = /<tool-use-id>([^<]+)<\/tool-use-id>/

/**
 * Tool names whose `tool_use` id enters the outstanding-subagent set on
 * identical terms: `Agent` launches a subagent fresh, `SendMessage` resumes
 * one that is already running. Both are real agent work — spec §6, "A
 * resumed agent is a real agent" — and both report their completion the same
 * way: a later entry carrying `subagent_tokens` whose id (`tool_result.
 * tool_use_id` or a `<tool-use-id>` tag) resolves THIS call's id, not
 * necessarily the original launch's. Admitting only `Agent` ids drops every
 * resumed agent's outstanding time entirely, because a `SendMessage` call's
 * completion never resolves anything in `pending` — measured on the
 * reference transcript, 106 of 425 completions carrying `subagent_tokens`
 * resolve a `SendMessage` id, worth 38.80h -> 48.99h of active time.
 */
const OUTSTANDING_TOOL_NAMES = new Set(['Agent', 'SendMessage'])

/** An assistant `tool_use` block that launches or resumes a real subagent. */
function isAgentToolUse(block) {
  return block?.type === 'tool_use' && OUTSTANDING_TOOL_NAMES.has(block.name)
}

/** The text of a `tool_result` block's `content`, whatever shape it comes in. */
function toolResultText(block) {
  if (typeof block?.content === 'string') return block.content
  if (Array.isArray(block?.content)) {
    return block.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
  }
  return ''
}

/**
 * Whether ANY text on this entry carries the `subagent_tokens` signal — the
 * discriminator between a genuine completion and a launch acknowledgement
 * (spec §6, "A launch acknowledgement is not a completion"). A backgrounded
 * `Agent` is answered within seconds by a `tool_result` on the SAME
 * `tool_use_id`, reading roughly "Async agent launched successfully... The
 * agent is working in the background. You will be notified automatically
 * when it completes." It carries no `subagent_tokens`. Treating any
 * `tool_result` match as a completion (the id guard alone) closed 68 of 256
 * launches on the reference transcript within 1-3 seconds of their own
 * start and threw away the real completion that arrived later — the id
 * guard says WHICH agent, this says THAT it finished; both are required.
 */
function hasSubagentTokens(entry) {
  for (const block of contentBlocks(entry)) {
    if (block?.type === 'tool_result' && toolResultText(block).includes('subagent_tokens')) return true
  }
  const text = typeof entry.content === 'string' ? entry.content
    : typeof entry.message?.content === 'string' ? entry.message.content
    : ''
  return text.includes('subagent_tokens')
}

/**
 * The `id`s an entry resolves, out of a set of ids we're still waiting on.
 *
 * A real transcript carries an outstanding agent's completion in TWO
 * different shapes, and a parser that only recognises one silently strands
 * the other's agents as outstanding forever (measured: doing so inflates a
 * 13.3h session to 139.5h active, because once one agent is stuck "open" the
 * entire rest of the file reads as active):
 *   1. The standard tool protocol: a `type: "user"` entry with a `tool_result`
 *      content block whose top-level `tool_use_id` answers the `Agent`
 *      tool_use directly — same pairing `interactiveIntervals` above uses for
 *      AskUserQuestion/ExitPlanMode. Its usage summary reads
 *      `subagent_tokens: N` (no angle brackets) buried in nested text.
 *   2. A supplementary `<task-notification>` — `type: "queue-operation"`, or
 *      `type: "user"` with a plain-string `message.content` — carrying
 *      `<tool-use-id>toolu_...</tool-use-id>` in that string, alongside
 *      `<subagent_tokens>N</subagent_tokens>`.
 * Rather than pattern-match either text format (fragile — real data has
 * already shown two shapes for the same signal), this resolves by `id`
 * membership in `pending`. `pending` only ever gains Agent ids (never
 * Bash's), so this is also the "background command must never count"
 * guarantee: a Bash tool_result can never match, no matter what its own
 * completion looks like, because its id was never added.
 *
 * That id guard alone is not sufficient, though: it answers WHICH agent, not
 * THAT it finished, and a backgrounded launch's own immediate acknowledgement
 * shares the id (see `hasSubagentTokens`). So this whole function is a no-op
 * unless the entry actually carries `subagent_tokens` — the launch ack never
 * does, a genuine completion (either shape) always does.
 */
function resolvingIds(entry, pending) {
  const ids = []
  if (!hasSubagentTokens(entry)) return ids
  for (const block of contentBlocks(entry)) {
    if (block?.type === 'tool_result' && pending.has(block.tool_use_id)) ids.push(block.tool_use_id)
  }
  const text = typeof entry.content === 'string' ? entry.content
    : typeof entry.message?.content === 'string' ? entry.message.content
    : ''
  const tagged = TOOL_USE_ID_TAG.exec(text)?.[1]
  if (tagged && pending.has(tagged)) ids.push(tagged)
  return ids
}

/**
 * Agent launch ids for which a completion — either shape `resolvingIds`
 * recognises — appears ANYWHERE in the file, independent of ordering or of
 * whether that completion falls before or after the launch's own turn ends.
 * This is a whole-file pre-pass, not a lookahead window: we already have the
 * entire transcript in memory before any turn is computed, so "does a
 * completion exist at all" is answerable exactly, with no window size to
 * tune and nothing that can drift.
 *
 * This is the sole input to the abandoned-launch rule below: an id in this
 * set is a genuinely long-running (or already-finished) agent and must keep
 * counting as outstanding across turn boundaries no matter how far away its
 * completion sits; an id NOT in this set never got a completion at all, in
 * this file, ever.
 *
 * Mirrors `resolvingIds`'s own gate: the `tool_result`-block branch below
 * only counts as a resolution when the entry carries `subagent_tokens`, for
 * the same reason — a launch acknowledgement is a `tool_result` on the same
 * id, seconds after the launch, and is not a completion.
 */
function launchIdsResolvedAnywhere(entries) {
  const launched = new Set()
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    for (const block of contentBlocks(entry)) {
      if (isAgentToolUse(block)) launched.add(block.id)
    }
  }
  const resolved = new Set()
  for (const entry of entries) {
    if (!hasSubagentTokens(entry)) continue
    for (const block of contentBlocks(entry)) {
      if (block?.type === 'tool_result' && launched.has(block.tool_use_id)) resolved.add(block.tool_use_id)
    }
    const text = typeof entry.content === 'string' ? entry.content
      : typeof entry.message?.content === 'string' ? entry.message.content
      : ''
    const tagged = TOOL_USE_ID_TAG.exec(text)?.[1]
    if (tagged && launched.has(tagged)) resolved.add(tagged)
  }
  return resolved
}

/**
 * For every entry index, how many subagents were outstanding in the gap
 * ENDING at that entry (i.e. the state after entries[i-1] was processed, and
 * before entries[i]'s own launches/resolutions are applied). Walking once
 * over the whole sorted timeline — not per turn — so a subagent launched near
 * one turn boundary and completed after the next real prompt is still
 * accounted for correctly.
 *
 * This is a union, not a sum: `pending.size` counts distinct outstanding ids,
 * so two overlapping subagents raise it to 2, not two separately-summed
 * durations — the wall-clock gap they share is counted once no matter how
 * many are outstanding at once (spec §6, "parallel subagents count once").
 * Resolving by id (rather than a blind increment/decrement counter) also
 * makes a duplicate completion notification for the same id a harmless no-op
 * — real transcripts echo a completion more than once (see `subagentTokensOf`
 * below), and a bare counter would double-decrement on the echo, wrongly
 * "closing" a different, still-genuinely-running agent's slot instead
 * (measured: a bare counter matched only 238 of 256 launches and left up to
 * 114 falsely outstanding at once; id-based resolution matches 255 of 256).
 *
 * ABANDONED LAUNCHES (this task's fix): on a real 16,198-line transcript, a
 * single `Agent` launch had no matching completion anywhere in the rest of
 * the file. Taking the spec's "regardless of length" literally for that one
 * launch kept it outstanding for the remaining ~2.3 days of the session,
 * inflating active time from an expected ~33.8h to 74.3h. A launch with no
 * completion anywhere means the agent was abandoned, killed, or the session
 * ended while it ran — in none of those cases did it actually work for two
 * days. So an unresolved launch (id not in `resolvedAnywhere`) stops counting
 * as outstanding at the end of the turn it was launched in — not at some
 * fixed time cap (there is no magic number here, and none is wanted: a
 * timeout would need tuning and could drift), but at the one structural
 * boundary the data itself gives us. A launch that DOES have a completion
 * somewhere in the file is never touched by this: it keeps counting right up
 * to that completion, across as many turns as it takes, exactly as before —
 * that is the case this fix must not break.
 */
function subagentOutstandingCounts(entries, starts, resolvedAnywhere) {
  const before = Array.from({ length: entries.length })
  const pending = new Set()
  // ids to drop from `pending` once the walk reaches a given boundary index —
  // populated only for ids launched with no completion anywhere in the file.
  const purgeAt = new Map()

  const turnEndAfter = (i) => {
    // First `starts` entry strictly greater than i, else end of file — i.e.
    // the boundary of the turn containing entry i.
    let lo = 0
    let hi = starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] > i) hi = mid
      else lo = mid + 1
    }
    return lo < starts.length ? starts[lo] : entries.length
  }

  for (let i = 0; i < entries.length; i += 1) {
    if (purgeAt.has(i)) {
      for (const id of purgeAt.get(i)) pending.delete(id)
      purgeAt.delete(i)
    }
    before[i] = pending.size
    const entry = entries[i]
    if (entry.type === 'assistant') {
      for (const block of contentBlocks(entry)) {
        if (!isAgentToolUse(block)) continue
        // A `SendMessage` is only a resumed SUBAGENT if something later
        // reports back on its id. The tool also addresses other sessions and
        // peers (`to: "<session name>"`, `uds:\\.\pipe\...`), which never do —
        // and a turn's window reaches up to the next real prompt, so holding
        // such a call "outstanding" to the end of its turn booked the whole
        // wait for the user's next message as agent work (measured: 62 of 126
        // launches in one session, 277h "active" across four-day gaps). The
        // end-of-turn allowance below stays for `Agent` alone: that one did
        // start a subagent, it merely never finished.
        if (block.name === 'SendMessage' && !resolvedAnywhere.has(block.id)) continue
        pending.add(block.id)
        if (!resolvedAnywhere.has(block.id)) {
          const boundary = turnEndAfter(i)
          if (!purgeAt.has(boundary)) purgeAt.set(boundary, [])
          purgeAt.get(boundary).push(block.id)
        }
      }
    }
    for (const id of resolvingIds(entry, pending)) pending.delete(id)
  }
  return before
}

/**
 * Subagent totals, deduped by task id and tracked as a running MAXIMUM, not a
 * first-seen value. Two things are true about a real transcript at once:
 *
 * 1. A completion notification can appear more than once for the SAME event
 *    (a `queue-operation` echo alongside the user-visible entry, same value,
 *    milliseconds apart) — counting both would double the figure.
 * 2. `<subagent_tokens>` is CUMULATIVE, not per-stop. "A task-notification
 *    fires each time this agent stops... the same task-id may notify more
 *    than once" (the harness's own note) — a resumed agent (`SendMessage` to
 *    continue it) reports a LARGER total on its next stop, not a fresh count.
 *    Deduping by "first occurrence wins" (this function's previous shape)
 *    keeps only the FIRST, smallest reading and throws away every
 *    resumption's additional work. Measured on the reference transcript: 14
 *    of 99 distinct task ids report more than one value; summing each task's
 *    first-seen value totals 12.86M, summing each task's MAXIMUM value totals
 *    13,378,132 — the figure the spec states (§6, "13.4M subagent tokens").
 *
 * So the correct rule is: track the highest value reported so far per task
 * id (`taskMax`, shared across every turn's call, covering the whole file);
 * a line whose value does not exceed that task's running max is a duplicate
 * echo (or a stale/out-of-order re-report) and contributes nothing; a line
 * that exceeds it is genuine additional work, and only the DELTA above the
 * previous max is added — crediting the increase to whichever turn's window
 * contains it, while the running total across all turns still sums to
 * exactly the final cumulative max per task, once, whole-file.
 *
 * These are NOT booked as cost — they carry no model and no input/output split,
 * so they cannot be priced (spec §6). They are surfaced by /ml-track:status so
 * the omission is visible.
 */
function subagentTokensOf(rawLines, taskMax) {
  let total = 0
  for (const line of rawLines) {
    if (!line.includes('subagent_tokens')) continue
    SUBAGENT_TOKENS.lastIndex = 0
    const match = SUBAGENT_TOKENS.exec(line)
    if (!match) continue
    const task = TASK_ID.exec(line)?.[1] ?? `anon:${taskMax.size}`
    const value = Number(match[1])
    const previousMax = taskMax.get(task) ?? 0
    if (value <= previousMax) continue
    taskMax.set(task, value)
    total += value - previousMax
  }
  return total
}

export function parseTurns(text, { idleThresholdSeconds = 120, subagentTexts = [] } = {}) {
  // Raw lines are carried alongside their parsed entry through both the
  // timestamp filter and the sort, so a later `rawLines.slice(from, to)`
  // against a turn's `entries` window indexes the SAME positions in both
  // arrays. Doing this against the original, unfiltered/unsorted
  // `text.split('\n')` (the previous approach) diverges by up to 22% on a
  // real transcript — 3,577 of 16,198 lines have no timestamp and are
  // dropped, and 321 more are reordered by the sort — so each turn's "raw
  // line slice" was an arbitrary window unrelated to that turn.
  const pairs = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      // Require the timestamp to actually PARSE, not merely be present: a
      // malformed value makes `Date.parse` return NaN, and `NaN` compares
      // false against both `< 0` and `> idleThresholdSeconds`, so a bad gap
      // silently falls through as neither excluded nor thresholded and
      // `activeSeconds` comes out NaN — which breaks the
      // active-never-exceeds-span invariant and serializes as `null` over
      // the wire. Admitting only entries with a finite parsed timestamp
      // keeps every downstream `toMs` call on a value already proven finite.
      const ms = parsed?.timestamp ? toMs(parsed.timestamp) : NaN
      if (Number.isFinite(ms)) pairs.push({ line, parsed, ms })
    } catch {
      // A partially-written last line is normal while a session is live.
    }
  }
  pairs.sort((a, b) => a.ms - b.ms)
  const entries = pairs.map((p) => p.parsed)
  const sortedRawLines = pairs.map((p) => p.line)

  const intervals = interactiveIntervals(entries)
  const starts = []
  entries.forEach((entry, index) => {
    if (isRealPrompt(entry)) starts.push(index)
  })

  const resolvedAnywhere = launchIdsResolvedAnywhere(entries)
  const outstandingBefore = subagentOutstandingCounts(entries, starts, resolvedAnywhere)
  const subagentTaskMax = new Map()

  const turns = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : entries.length
    const window = entries.slice(from, to)
    if (!window.some((e) => e.type === 'assistant')) continue

    const usage = new Map()
    let active = 0
    for (let k = 0; k < window.length; k += 1) {
      if (window[k].type === 'assistant') accumulateUsage(usage, window[k])
      if (k === 0) continue
      const previous = window[k - 1]
      const current = window[k]
      const previousMs = toMs(previous.timestamp)
      const currentMs = toMs(current.timestamp)
      const gap = (currentMs - previousMs) / 1000
      if (gap < 0) continue
      // An interactive wait is excluded even while a subagent is outstanding
      // — this check must run before the outstanding-subagent branch below,
      // not after, or a human-input wait mid-subagent would wrongly count.
      if (isInteractiveGap(intervals, previousMs, currentMs)) continue
      // A subagent grinding on the task is working, not waiting: the gap
      // counts as active regardless of length. `outstandingBefore[from + k]`
      // is the count as of just after `previous` was processed, i.e. the
      // state that governed the whole gap up to `current`.
      if (outstandingBefore[from + k] > 0) {
        active += gap
        continue
      }
      if (gap > idleThresholdSeconds) continue
      active += gap
    }

    const startedAt = window[0].timestamp
    const endedAt = window[window.length - 1].timestamp
    turns.push({
      turnUuid: window[0].uuid,
      startedAt,
      endedAt,
      spanSeconds: Math.round((toMs(endedAt) - toMs(startedAt)) / 1000),
      activeSeconds: Math.round(active),
      usageMap: usage,
      subagentTokens: subagentTokensOf(sortedRawLines.slice(from, to), subagentTaskMax),
    })
  }

  // Subagent attribution (this task's brief): each subagent `.output`
  // transcript's assistant entries are folded into the parent turn whose
  // [startedAt, endedAt] window contains their timestamp — see
  // `findContainingTurn`'s own doc comment for the measured guarantee this
  // relies on. Done as a separate pass, after every main turn's own window
  // and usage are final, because attribution needs ALL turns' boundaries at
  // once (a subagent entry can be closer in file order to one turn but
  // timestamp-fall inside another).
  if (subagentTexts.length > 0 && turns.length > 0) {
    const bounds = turns.map((t) => ({ startMs: toMs(t.startedAt), endMs: toMs(t.endedAt) }))
    for (const rawText of subagentTexts) {
      for (const { ms, entry } of parseSubagentEntries(rawText)) {
        const idx = findContainingTurn(bounds, ms)
        if (idx === -1) continue
        accumulateUsage(turns[idx].usageMap, entry, 'subagent')
      }
    }
  }

  return turns.map(({ usageMap, ...turn }) => ({ ...turn, usage: [...usageMap.values()] }))
}

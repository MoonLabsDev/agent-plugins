/** Codex rollout adapter. Only completed turns are eligible for booking. */
export const INTERACTIVE_TOOLS = new Set(['request_user_input', 'functions.request_user_input', 'functions.request_user_input_async'])
const n = v => Number.isFinite(v) && v >= 0 ? v : 0
export function parseTurns(text, { idleThresholdSeconds = 120, completedTurnId } = {}) {
  const rows = []
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line)
      if (Number.isFinite(Date.parse(r.timestamp))) rows.push(r)
    } catch { /* Live transcripts may have an incomplete last line. */ }
  }
  const turns = new Map()
  let current, model = 'unknown', effort = 'none', previousTotal = {}
  const responseIds = new Set()
  for (const r of rows) {
    const p = r.payload ?? {}, ms = Date.parse(r.timestamp)
    if (r.type === 'event_msg' && p.type === 'task_started') {
      if (!p.turn_id) continue
      current = turns.get(p.turn_id)
      if (!current) {
        current = { turnUuid: p.turn_id, startedAt: r.timestamp, endedAt: r.timestamp, rows: [], records: [], fallback: [], complete: false }
        turns.set(p.turn_id, current)
      }
    }
    if (r.type === 'turn_context') {
      model = p.model ?? model
      effort = p.effort ?? p.reasoning_effort ?? effort
    }
    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const total = p.info.total_token_usage
      const delta = Object.fromEntries(Object.keys(total).map(k => [k, Math.max(0, n(total[k]) - n(previousTotal[k]))]))
      // A resumed provider may reset cumulative totals. Its last usage is then authoritative.
      const reset = n(total.input_tokens) < n(previousTotal.input_tokens)
      if (current) current.fallback.push({ usage: reset ? p.info.last_token_usage ?? total : delta, model, effort })
      previousTotal = total
    }
    if (!current) continue
    if (!current.complete) {
      current.rows.push({ ...r, ms })
      current.endedAt = r.timestamp
    }
    if (r.type === 'token_usage_record') {
      const target = turns.get(p.turn_id) ?? current
      const key = p.response_id ?? JSON.stringify([p.turn_id, r.timestamp, p.usage])
      if (!responseIds.has(key) && p.usage) {
        responseIds.add(key)
        target.records.push({ usage: p.usage, model: p.model ?? model, effort: p.effort ?? effort })
      }
    }
    if (r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(p.type)) {
      if (!p.turn_id || p.turn_id === current.turnUuid) current.complete = true
    }
  }
  if (current?.turnUuid === completedTurnId) current.complete = true
  const result = []
  for (const t of turns.values()) {
    if (!t.complete) continue
    const buckets = new Map()
    // A token_usage_record is one response, so its usage is one request's and
    // a long-context price can apply to it (priced by the server). A token_count
    // delta may span several requests: those buckets carry no `requests` and
    // stay at the short rates.
    const perRequest = t.records.length > 0
    for (const item of perRequest ? t.records : t.fallback) {
      const key = `${item.model}|${item.effort}`
      const b = buckets.get(key) ?? { model: item.model, effort: item.effort, origin: 'main', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, ...(perRequest ? { requests: [] } : {}) }
      const u = item.usage
      const request = {
        inputTokens: Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens) - n(u.cache_write_input_tokens)),
        outputTokens: n(u.output_tokens), // reasoning_output_tokens is already included.
        cacheReadTokens: n(u.cached_input_tokens),
        cacheWrite5mTokens: n(u.cache_write_input_tokens),
        cacheWrite1hTokens: 0,
      }
      b.inputTokens += request.inputTokens
      b.outputTokens += request.outputTokens
      b.cacheReadTokens += request.cacheReadTokens
      b.cacheWrite5mTokens += request.cacheWrite5mTokens
      if (perRequest) b.requests.push(request)
      buckets.set(key, b)
    }
    const waits = [], pending = new Map()
    for (const r of t.rows) {
      const p = r.payload ?? {}
      if (r.type === 'response_item' && p.type === 'function_call' && INTERACTIVE_TOOLS.has(p.name)) pending.set(p.call_id, r.ms)
      if (r.type === 'response_item' && p.type === 'function_call_output' && pending.has(p.call_id)) {
        waits.push([pending.get(p.call_id), r.ms]); pending.delete(p.call_id)
      }
    }
    for (const ms of pending.values()) waits.push([ms, Date.parse(t.endedAt)])
    let activeSeconds = 0
    for (let i = 1; i < t.rows.length; i++) {
      const a = t.rows[i - 1].ms, b = t.rows[i].ms, gap = (b - a) / 1000
      if (gap >= 0 && gap <= idleThresholdSeconds && !waits.some(([x,y]) => a >= x && b <= y)) activeSeconds += gap
    }
    result.push({ turnUuid: t.turnUuid, startedAt: t.startedAt, endedAt: t.endedAt, spanSeconds: Math.max(0, Math.round((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000)), activeSeconds: Math.round(activeSeconds), usage: [...buckets.values()], subagentTokens: 0 })
  }
  return result
}

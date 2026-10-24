/**
 * Agent records are ALWAYS booked not-billable (spec P4). A human reviews the
 * work and flags it later; the server resolves and stamps the rate at creation
 * regardless, so flipping the flag later prices the work at the rate that
 * applied when it happened, not today's.
 */
const BILLABLE = false

/**
 * Derived, never random (spec §7): re-running backfill over an already-booked
 * session cannot double-book, because the server replays its stored response
 * instead of inserting.
 */
export const idempotencyKeyFor = (sessionId, turn) => `${sessionId}:${turn.turnUuid}`

/**
 * One usage in the API's shape. The five token counts only — the server
 * prices them with the instance's model prices (Instanz → KI-Preise) when it
 * stores the booking, so a price corrected there reaches every install at
 * once and this plugin never needs a price table of its own.
 */
const tokensOf = (usage) => ({
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  cache_read_tokens: usage.cacheReadTokens,
  cache_write_short_tokens: usage.cacheWrite5mTokens,
  cache_write_long_tokens: usage.cacheWrite1hTokens,
})

/**
 * `sessionId` is REQUIRED and throws when absent, rather than defaulting to
 * null. The server uses it to keep one project's concurrent conversations in
 * separate records; a payload built without one books into whatever
 * null-session record the agent last wrote, which is the exact silent
 * mis-merge the field exists to prevent. A missing session id is a bug in the
 * caller, and this is the only place that can still tell.
 */
export function buildPayload(turn, { projectId, description, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new TypeError('buildPayload needs a sessionId')
  }
  if (typeof turn.turnUuid !== 'string' || turn.turnUuid === '') {
    throw new TypeError('buildPayload needs a turnUuid')
  }
  return {
    project_id: projectId,
    session_id: sessionId,
    turn_id: turn.turnUuid,
    description: description ?? '',
    started_at: turn.startedAt,
    ended_at: turn.endedAt,
    active_seconds: turn.activeSeconds,
    billable: BILLABLE,
    costs: turn.usage.map((bucket) => ({
      model: bucket.model,
      effort: bucket.effort,
      // Passed through: origin ('main' vs 'subagent') is an attribution
      // label transcript.mjs already resolved. 'main' when it never set one.
      origin: bucket.origin ?? 'main',
      ...tokensOf(bucket),
      // Each request's own usage, when the parser kept it: a long-context
      // price applies per request, by that request's prompt size, and only
      // the server knows the threshold. Absent, the server prices the whole
      // entry at the short-context rates.
      ...(Array.isArray(bucket.requests) ? { requests: bucket.requests.map(tokensOf) } : {}),
    })),
  }
}

import { priceUsage } from './pricing.mjs'

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
  return {
    project_id: projectId,
    session_id: sessionId,
    description: description ?? '',
    started_at: turn.startedAt,
    ended_at: turn.endedAt,
    active_seconds: turn.activeSeconds,
    billable: BILLABLE,
    costs: turn.usage.map((bucket) => {
      const priced = priceUsage(bucket)
      return {
        model: priced.model,
        effort: priced.effort,
        origin: priced.origin,
        input_tokens: priced.inputTokens,
        output_tokens: priced.outputTokens,
        cache_read_tokens: priced.cacheReadTokens,
        cache_write_tokens: priced.cacheWriteTokens,
        cost_micros: priced.costMicros,
        input_cost_micros: priced.inputCostMicros,
        output_cost_micros: priced.outputCostMicros,
        cache_read_cost_micros: priced.cacheReadCostMicros,
        cache_write_cost_micros: priced.cacheWriteCostMicros,
        currency: priced.currency,
      }
    }),
  }
}

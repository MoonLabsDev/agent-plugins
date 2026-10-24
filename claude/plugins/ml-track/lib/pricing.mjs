import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Transcripts carry `model`, `effort` and full `usage` — but no price. So the
 * client prices it, and the figure means "what this work would cost at API
 * list price" (spec P6), in USD, booked without FX per the agent spec's D9.
 *
 * The five buckets are not over-engineering: on a measured session the main
 * thread read 2.46 BILLION cached tokens against 5.2M output tokens. Pricing
 * cache reads at the input rate would overstate that session by more than an
 * order of magnitude.
 */
const table = JSON.parse(
  readFileSync(fileURLToPath(new URL('../pricing-table.json', import.meta.url)), 'utf8'),
)

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']

/**
 * A hand-written table has exactly one way to go wrong that matters here: a
 * row missing one of the five rate fields (or carrying a non-numeric value —
 * a stray string, `null`, `NaN` typo'd into the JSON). Multiplying against a
 * missing/non-finite field produces `NaN`, which poisons the whole summed
 * cost via `+`; `NaN` serializes as `null` over the wire and the server's
 * `z.number().int()` rejects it — 400, forever, with `unpriced` still false
 * because `rates` is not literally `undefined`. Dropping an invalid row here
 * (rather than at the call site in `priceUsage`) means `rates === undefined`
 * downstream, so an incomplete row and an unknown model take the exact same
 * path: booked at zero cost, flagged in `unpricedModels`, never NaN.
 */
function isValidRateRow(rates) {
  return rates !== null && typeof rates === 'object'
    && RATE_FIELDS.every((field) => Number.isFinite(rates[field]))
}
for (const [model, rates] of Object.entries(table.models)) {
  if (!isValidRateRow(rates)) delete table.models[model]
}

export const TABLE_VERSION = table.version

/**
 * Anthropic dated snapshot ids (`claude-haiku-4-5-20251001`) are a real model
 * a session can report, but the pricing table keys models by their UNDATED
 * family name (`claude-haiku-4-5`) — measured on real subagent transcripts,
 * 157 entries carried the dated id and an exact-key lookup silently priced
 * them at $0 (booked as "unpriced", not flagged as an error, since the row
 * genuinely does not exist under that exact key). Stripping a trailing
 * `-YYYYMMDD` and retrying once catches this without guessing at any other
 * naming scheme; a model that still doesn't resolve after stripping is
 * genuinely unknown and stays unpriced.
 */
const DATED_SNAPSHOT_SUFFIX = /-\d{8}$/

function ratesFor(model) {
  if (table.models[model]) return table.models[model]
  const undated = model.replace(DATED_SNAPSHOT_SUFFIX, '')
  return undated === model ? undefined : table.models[undated]
}

/**
 * Four buckets, four independently-rounded costs, summed — never one round
 * over the combined raw total (D-repo-062, the server's own rule this must
 * satisfy: the four `*_cost_micros` buckets must sum to `cost_micros`
 * EXACTLY, no tolerance). Rounding the total separately from the buckets
 * would disagree with their sum on almost any real session and 400 forever
 * (`cost.bucket_mismatch`) — see lib/pricing.mjs's test file for the
 * hand-checked case this changes versus the old single-round behaviour.
 *
 * The cache_write bucket alone still spans two different rates (5-minute
 * cache = 1.25x input, 1-hour cache = 2x input, spec P6): summed from that
 * finer split, then rounded once for the bucket as a whole — not per-TTL,
 * which would double-round the same bucket's own money.
 */
export function priceUsage(bucket) {
  const rates = ratesFor(bucket.model)
  const r = rates ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

  const inputCostMicros = Math.round(bucket.inputTokens * r.input)
  const outputCostMicros = Math.round(bucket.outputTokens * r.output)
  const cacheReadCostMicros = Math.round(bucket.cacheReadTokens * r.cacheRead)
  const cacheWriteCostMicros = Math.round(
    bucket.cacheWrite5mTokens * r.cacheWrite5m + bucket.cacheWrite1hTokens * r.cacheWrite1h,
  )
  const costMicros = inputCostMicros + outputCostMicros + cacheReadCostMicros + cacheWriteCostMicros

  return {
    model: bucket.model,
    effort: bucket.effort,
    // Passed through, never priced: origin ('main' vs 'subagent') is an
    // attribution label transcript.mjs already resolved, not something this
    // function decides. Defaults to 'main' so a caller that never set it
    // (every pre-existing call site) keeps its old behaviour unchanged.
    origin: bucket.origin ?? 'main',
    // input_tokens is now STRICTLY non-cached input (D-repo-062's bug fix) —
    // cache writes get their own bucket below and must never be folded in
    // here again.
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWrite5mTokens + bucket.cacheWrite1hTokens,
    costMicros,
    inputCostMicros,
    outputCostMicros,
    cacheReadCostMicros,
    cacheWriteCostMicros,
    currency: table.currency,
    unpriced: rates === undefined,
  }
}

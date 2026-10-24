/**
 * Previews the server's own `findMergeTarget` coalescing rule
 * (src/services/time-records.ts, ~line 440) client-side, so
 * `/ml-track:backfill`'s dry run can show what will ACTUALLY be booked —
 * coalesced records — not raw turns. This is a PREVIEW only: the server
 * performs the real merge at booking time regardless of what this function
 * decides, so a mismatch here (e.g. a project rate changing mid-session,
 * which this function cannot see) affects only the confirmation table, never
 * what actually gets written.
 *
 * ml-track always books one project, always not-billable (payload.mjs's
 * BILLABLE=false — spec P4), so two of the server's four match conditions
 * (project, billable) are always true for turns from one dry run and are not
 * checked here. Rate is NOT checked either: the plugin never learns the
 * resolved rate (the server resolves and stamps it at creation), so this
 * assumes it stays constant across one backfill run — true in practice since
 * a project's rate rarely changes intra-session, but not verified.
 */

/**
 * A civil date as `yyyy-MM-dd` in the given IANA zone (Europe/Berlin by
 * default), mirroring src/lib/time.ts's `dayKey` — but built on `Intl`
 * instead of `date-fns-tz`, since this plugin is deliberately dependency-free
 * (no package.json, no node_modules). `en-CA` is the one built-in locale
 * whose default date format is already `yyyy-MM-dd`.
 */
export function dayKeyBerlin(iso, timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
}

/**
 * One turn's tokens, main thread by bucket and subagents as one count. No
 * money: the server prices the tokens when it books them (KI-Preise), so a
 * preview that guessed a price could only disagree with what gets booked.
 */
function tokensOfTurn(turn) {
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, subagentUsageTokens: 0 }
  for (const bucket of turn.usage) {
    const write = bucket.cacheWrite5mTokens + bucket.cacheWrite1hTokens
    if (bucket.origin === 'subagent') {
      tokens.subagentUsageTokens += bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + write
      continue
    }
    tokens.inputTokens += bucket.inputTokens
    tokens.outputTokens += bucket.outputTokens
    tokens.cacheReadTokens += bucket.cacheReadTokens
    tokens.cacheWriteTokens += write
  }
  return tokens
}

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'subagentUsageTokens']

/**
 * Coalesces turns into the records the server would actually book.
 *
 * `mergeGapSeconds` must be the agent's REAL, currently-in-force value
 * (`agents.merge_gap_seconds`, exposed on `GET /api/v1/me`'s `agent` object)
 * — never a guess. `<= 0` or non-finite (NaN, null, undefined — the shape a
 * caller uses when it could not confirm the real value) disables merging
 * entirely: 0 matches the server's own "0 disables coalescing" rule
 * (findMergeTarget's doc comment), and an unconfirmed value must degrade the
 * SAME way rather than silently assuming some other number — showing every
 * turn as its own record is a safe (if less useful) preview; showing a wrong
 * merge is not.
 *
 * The day rule compares each candidate turn's OWN start day to the group's
 * OWN start day (fixed at the group's first turn, never updated as turns
 * merge in) — not to the group's current end. This is `findMergeTarget`'s
 * own rule (`dayKey(previous.startedAt) !== dayKey(candidate.startedAt)`),
 * and it is why a group can legitimately end after midnight: only the
 * START of each piece has to agree with the group's start, never the end.
 */
export function groupTurns(turns, mergeGapSeconds, timeZone = 'Europe/Berlin') {
  const canMerge = Number.isFinite(mergeGapSeconds) && mergeGapSeconds > 0
  const groups = []
  for (const turn of turns) {
    const tokens = tokensOfTurn(turn)
    const last = groups[groups.length - 1]
    if (canMerge && last) {
      const gapSeconds = (Date.parse(turn.startedAt) - Date.parse(last.endedAt)) / 1000
      const sameStartDay = dayKeyBerlin(last.startedAt, timeZone) === dayKeyBerlin(turn.startedAt, timeZone)
      if (gapSeconds >= 0 && gapSeconds <= mergeGapSeconds && sameStartDay) {
        last.endedAt = turn.endedAt
        last.activeSeconds += turn.activeSeconds
        for (const key of TOKEN_KEYS) last[key] += tokens[key]
        continue
      }
    }
    groups.push({
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      activeSeconds: turn.activeSeconds,
      ...tokens,
    })
  }
  return groups
}

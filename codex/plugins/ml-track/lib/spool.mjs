import fs, { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import * as paths from './paths.mjs'

/**
 * The ledger is the PRIMARY dedupe: an entry marked `booked` is never sent
 * again. The derived Idempotency-Key is the second line of defence, covering
 * only the crash between a successful POST and this file being rewritten.
 *
 * The byte offset persisted here is a change-detection hint, not a read
 * cursor: spec §6 requires parseTurns to see the whole transcript on every
 * call (its outstanding-agent and abandoned-launch rules are whole-file
 * pre-passes), so callers must never seek to the stored offset and feed
 * parseTurns a suffix.
 *
 * Every rewrite of the spool or state file goes through `atomicWriteFileSync`
 * below, never a direct `writeFileSync` on the live path: `writeFileSync`
 * opens with the default truncating 'w' flag, so a crash between the
 * truncate and the write completing (OOM kill, power loss, SIGKILL) can leave
 * the file empty or half-written, and `readEntries` treats that as "no
 * entries" — silently losing every booking for the session. Writing to a
 * temp file in the same directory and `renameSync`-ing it over the target
 * avoids that: rename is atomic on POSIX and on same-volume NTFS, so a crash
 * leaves either the old complete file or the new complete file, never a
 * truncated one.
 */
function atomicWriteFileSync(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

// Session ids are harness-generated (Claude Code session UUIDs), not user
// input, and are interpolated into filenames by paths.spoolFile/stateFile.
// Reject anything that isn't a safe filename fragment (word chars, '-', '.')
// so a malformed id fails loudly here instead of resolving to a path outside
// the spool directory.
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/
export function assertSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || !SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`unsafe sessionId: ${JSON.stringify(sessionId)}`)
  }
}

const ensureDir = () => mkdirSync(paths.spoolDir(), { recursive: true })

/**
 * The spool directory, created if needed. Exposed so `backfill`'s dry run can
 * place its plan file alongside the spool it will later be read back
 * against — the one thing outside this module's own writes that a caller is
 * allowed to derive from paths.mjs indirectly, rather than importing
 * paths.mjs itself.
 */
export const spoolRoot = () => { ensureDir(); return paths.spoolDir() }

/**
 * In-process ledger cache, keyed by sessionId: the array of entry OBJECTS
 * this process currently believes matches the on-disk ledger for that
 * session. This exists to close an O(n^2) hole (Important finding I4): the
 * Stop hook re-parses the WHOLE transcript every turn (a whole-file pre-pass
 * is required — see transcript.mjs), so its turn loop calls `appendPending`
 * once per turn the parser returns, including every earlier turn already in
 * the ledger (dedup is `appendPending`'s own job). Before this cache, EVERY
 * one of those calls re-read and re-parsed the entire ledger file from
 * scratch — on a warm 211-entry ledger, measured at ~98ms of a ~665ms
 * per-turn hook cost, and growing with the transcript. Caching means the
 * first read of a session in this process hits disk once; every later call
 * for that SAME session is served from memory.
 *
 * Every write this module makes (`writeAll`, and `appendPending`'s own
 * `appendFileSync`) keeps this cache in exact sync with what it wrote, so a
 * cache hit is never staler than the last write this process itself made.
 * Nothing outside THIS PROCESS can invalidate it — and cross-process
 * concurrent writers on the SAME session's ledger are an ordinary
 * occurrence here, not a hypothetical (flush.mjs's own doc comment: a live
 * Stop hook's appendPending and a separate detached flusher's markBooked
 * commonly race on the same file). `readEntries`/`appendPending` staying
 * cache-only (never re-reading disk) is still correct because they only
 * ever ADD, never remove or overwrite another writer's entry. `writeAll` is
 * the one place that could silently erase a concurrent writer's entry (an
 * unsynchronised whole-file rewrite sourced only from a stale in-memory
 * copy — Finding 2) — see its own doc comment for how it re-reads and
 * merges instead of overwriting blind.
 *
 * `readEntries` returns the cached array itself, not a defensive copy:
 * `markBooked`/`recordAttempt` already rely on "read, mutate the entry
 * objects in place, `writeAll` the same array", and must keep doing so
 * unchanged now that the array they get back is shared cache state instead
 * of a fresh parse — a copy here would silently break that.
 */
const ledgerCache = new Map()

function loadLedgerFromDisk(sessionId) {
  const file = paths.spoolFile(sessionId)
  if (!existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function readEntries(sessionId) {
  assertSafeSessionId(sessionId)
  if (!ledgerCache.has(sessionId)) {
    ledgerCache.set(sessionId, loadLedgerFromDisk(sessionId))
  }
  return ledgerCache.get(sessionId)
}

/**
 * Merges `entries` (this call's in-memory truth: whatever this process just
 * mutated or filtered) with whatever is currently on disk, by `turnUuid`,
 * before the rewrite (Finding 2). This is what lets a concurrent writer's
 * appendFileSync — a live Stop hook's own appendPending, or another
 * detached flusher, see flush.mjs's own doc comment — survive a rewrite
 * this process makes to the SAME ledger, instead of being silently erased
 * by a stale in-memory copy.
 *
 * `entries` wins for any turnUuid it carries (this process's own writes are
 * always authoritative over what it just read). A disk-only turnUuid is
 * kept UNLESS it was already known to this process's cache before this call
 * (`knownBefore`) — that distinguishes a foreign writer's entry (unknown,
 * keep it) from one THIS process deliberately dropped, e.g. prune() (known,
 * respect the drop). `knownBefore` is simply the cache's own state at the
 * top of this call: every caller reads via `readEntries` first, which
 * either serves the existing cached array (mutate-in-place callers, so
 * `entries === knownBefore`, and this whole distinction is a no-op) or a
 * fresh disk load; prune() alone passes a NEW filtered array, so
 * `knownBefore` still holds the pre-filter set at that point.
 */
const writeAll = (sessionId, entries) => {
  ensureDir()
  const knownBefore = ledgerCache.get(sessionId) ?? entries
  const knownTurnUuids = new Set(knownBefore.map((e) => e.turnUuid))
  const onDisk = loadLedgerFromDisk(sessionId)
  const byTurn = new Map(entries.map((e) => [e.turnUuid, e]))
  for (const e of onDisk) {
    if (!byTurn.has(e.turnUuid) && !knownTurnUuids.has(e.turnUuid)) {
      byTurn.set(e.turnUuid, e)
    }
  }
  const merged = [...byTurn.values()]
  atomicWriteFileSync(
    paths.spoolFile(sessionId),
    merged.map((e) => JSON.stringify(e)).join('\n') + '\n',
  )
  ledgerCache.set(sessionId, merged)
}

export function appendPending(sessionId, { turnUuid, idempotencyKey, payload }) {
  assertSafeSessionId(sessionId)
  const entries = readEntries(sessionId)
  const existing = entries.find((e) => e.turnUuid === turnUuid)
  if (existing) {
    // Already-booked legacy aggregates have no recoverable turn identity on
    // the server. Keep them intact; only turn-aware bookings can be corrected.
    if (existing.status === 'booked' && !existing.payload.turn_id) return false
    if (JSON.stringify(existing.payload) === JSON.stringify(payload)) return false
    Object.assign(existing, { payload, idempotencyKey, status: 'pending' })
    writeAll(sessionId, entries)
    return true
  }
  ensureDir()
  const entry = { turnUuid, idempotencyKey, payload, status: 'pending' }
  appendFileSync(
    paths.spoolFile(sessionId),
    JSON.stringify(entry) + '\n',
    'utf8',
  )
  entries.push(entry)
  return true
}

export function markBooked(sessionId, turnUuid, recordId, sentPayload) {
  assertSafeSessionId(sessionId)
  const entries = loadLedgerFromDisk(sessionId)
  ledgerCache.set(sessionId, entries)
  for (const entry of entries) {
    if (entry.turnUuid !== turnUuid) continue
    // A hook may have corrected a measurement while this request was in flight.
    if (sentPayload && JSON.stringify(entry.payload) !== JSON.stringify(sentPayload)) continue
    entry.status = 'booked'
    entry.recordId = recordId
    entry.bookedAt = new Date().toISOString()
  }
  writeAll(sessionId, entries)
}

/**
 * Records a failed send attempt without changing the entry's status — it
 * stays `pending` and is retried on the next flush, same as before this
 * bookkeeping existed. This is what lets `/ml-track:status` (and anything
 * else reading the ledger) tell "will succeed next time" apart from "has
 * been failing for N attempts", instead of both looking like a bare pending
 * count.
 *
 * `lastError` must carry only `status` and `message`, never the response
 * body: a server that echoes request headers back in an error body can leak
 * the bearer token through `ApiError.body`, and that must never be persisted
 * to the spool.
 */
export function recordAttempt(sessionId, turnUuid, { status, message } = {}) {
  assertSafeSessionId(sessionId)
  const entries = readEntries(sessionId)
  for (const entry of entries) {
    if (entry.turnUuid !== turnUuid) continue
    entry.attempts = (entry.attempts ?? 0) + 1
    entry.lastError = { status: status ?? null, message: message ?? null }
  }
  writeAll(sessionId, entries)
}

const readState = (sessionId) => {
  const file = paths.stateFile(sessionId)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

const writeState = (sessionId, state) => {
  ensureDir()
  atomicWriteFileSync(paths.stateFile(sessionId), JSON.stringify(state, null, 2) + '\n')
}

export const readOffset = (sessionId) => {
  assertSafeSessionId(sessionId)
  return readState(sessionId).offset ?? 0
}
export const writeOffset = (sessionId, offset) => {
  assertSafeSessionId(sessionId)
  writeState(sessionId, { ...readState(sessionId), offset })
}

export const readDescription = (sessionId) => {
  assertSafeSessionId(sessionId)
  return readState(sessionId).description ?? ''
}
export const writeDescription = (sessionId, description) => {
  assertSafeSessionId(sessionId)
  writeState(sessionId, { ...readState(sessionId), description })
}

export function prune(sessionId, days) {
  assertSafeSessionId(sessionId)
  const cutoff = Date.now() - days * 86_400_000
  const kept = readEntries(sessionId).filter(
    (e) => e.status !== 'booked' || !e.bookedAt || Date.parse(e.bookedAt) > cutoff,
  )
  writeAll(sessionId, kept)
}

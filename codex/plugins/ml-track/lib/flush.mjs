import { openSync, writeSync, closeSync, unlinkSync, statSync, mkdirSync } from 'node:fs'
import { readEntries, markBooked, recordAttempt } from './spool.mjs'
import * as paths from './paths.mjs'

/**
 * How long a lock is honoured before a new flusher takes it over anyway. A
 * flusher that dies mid-run (killed process, OOM, a crashed container) must
 * not leave the lock held forever — that would silently stop every future
 * flush from doing anything, which is far worse than the ledger race the
 * lock exists to prevent. An ordinary flush sends a handful of HTTP requests
 * and finishes in well under a second even over a slow network, so a few
 * minutes is generous headroom without leaving a dead lock in place for long.
 */
const LOCK_STALE_MS = 5 * 60 * 1000

/**
 * Attempts to take the single global flush lock (paths.lockFile()).
 *
 * Uses an exclusive-create open ('wx') so the check ("does a lock already
 * exist?") and the claim ("create it as mine") are one atomic filesystem
 * operation — a separate `existsSync` followed by a `writeFileSync` has its
 * own race between two flushers starting at the same instant, which is
 * exactly the class of bug this lock exists to close. Writes the holder's
 * pid and a timestamp into the file so a human debugging a stuck lock can
 * see what (and roughly when) holds it.
 *
 * Returns true if this call now holds the lock (whether freshly created or
 * taken over from a stale holder), false if a live lock is held by someone
 * else and this call backed off instead.
 */
function acquireLock() {
  mkdirSync(paths.spoolDir(), { recursive: true })
  const file = paths.lockFile()
  const claim = () => {
    const fd = openSync(file, 'wx')
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    } finally {
      closeSync(fd)
    }
  }
  try {
    claim()
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  // A lock file already exists. Stale (older than LOCK_STALE_MS) means its
  // holder is presumed dead, so this call takes it over; fresh means a flush
  // is genuinely in progress, so this call backs off instead.
  let stale
  try {
    stale = Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS
  } catch {
    // The lock vanished between the failed claim above and this stat — its
    // holder just finished and released it. Retry the exclusive create once
    // now that the coast may be clear.
    return acquireLock()
  }
  if (!stale) return false
  try { unlinkSync(file) } catch { /* another stale-breaker already removed it */ }
  try {
    claim()
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false // someone else re-claimed it first
    throw error
  }
}

/**
 * Releases the flush lock. Never throws: a lock file that is already gone
 * (already released, or this call never actually held it) is fine to no-op
 * past — this is always called from a `finally`, including on the throwing
 * path, and must not itself become a new way to fail there.
 */
function releaseLock() {
  try { unlinkSync(paths.lockFile()) } catch { /* already gone */ }
}

/**
 * Sends every pending entry. Failures stay pending and go out with the next
 * flush — a stopped container or a VPN blip must never cost a booking, and
 * must never stall the turn that produced it. A permanently-rejected entry
 * (e.g. a 400 from a malformed payload) also stays pending and keeps being
 * retried forever — this module never drops or caps an entry — but each
 * failed attempt is recorded via `recordAttempt` so that fact is visible
 * instead of silently indistinguishable from "will succeed next time".
 *
 * `errors` (and what's recorded via `recordAttempt`) carries only `status`
 * and `message` (never `error.body`, which can hold an echoed request header
 * — including the bearer token — on a server that reflects what it received)
 * so neither this return value nor the spool can ever widen token exposure
 * beyond what a raw ApiError already risks.
 *
 * `restrictTo` (an optional iterable/Set of `turnUuid`s) narrows which
 * pending entries get sent. It exists for `backfill --commit`: that command
 * shows the user a confirmation table built from one specific set of turns,
 * then appends only those turns' entries to the spool before flushing. But
 * this is the SAME session the live Stop hook may still be spooling into
 * while the user reads that table — an unrestricted flush would sweep in
 * whatever the hook queued in the meantime and book it too, silently, even
 * though it never appeared in what the user approved. Passing the plan's own
 * `turnUuid`s here is what keeps "what you saw is what was written" true.
 * Omit it (as the Stop hook's own flush and the `flush` verb both do) and
 * behaviour is unchanged: every pending entry for the session goes out, which
 * is exactly what lets a stuck entry from an earlier failed attempt
 * eventually leave.
 *
 * Runs under the single global flush lock (paths.lockFile()). Every rewrite
 * of the spool file (markBooked, recordAttempt) is an unsynchronised read ->
 * mutate -> whole-file rewrite (see spool.mjs's atomicWriteFileSync doc
 * comment), so two flushSession calls racing on the same session's ledger
 * have a lost-update window: one flusher's markBooked/recordAttempt can be
 * silently overwritten by the other's. hooks.json wires both `Stop` and
 * `SessionEnd` to spawn a detached flush, so two flushers running at once is
 * an ordinary occurrence here, not a hypothetical.
 *
 * If a second call finds the lock already held (and not stale), it returns
 * immediately having sent nothing — `{ booked: 0, failed: 0, errors: [],
 * locked: true }` — rather than waiting or retrying. That is by design: the
 * flusher already holding the lock will itself reach these same pending
 * entries (nothing here is scoped to "what existed when I started"), so no
 * work is lost, only deferred to whichever flusher is already running. A
 * hook must never disrupt a turn, so this path is silent and successful, not
 * a noisy failure.
 */
export async function flushSession(sessionId, api, restrictTo) {
  if (!acquireLock()) {
    return { booked: 0, failed: 0, errors: [], locked: true }
  }
  try {
    const restrict = restrictTo ? new Set(restrictTo) : null
    const errors = []
    let booked = 0
    let failed = 0
    const todo = readEntries(sessionId).filter(
      (entry) => entry.status !== 'booked' && (!restrict || restrict.has(entry.turnUuid)),
    )
    for (const [index, entry] of todo.entries()) {
      try {
        const record = await api.createRecord(entry.payload, entry.idempotencyKey)
        markBooked(sessionId, entry.turnUuid, record.id, entry.payload)
        booked += 1
      } catch (error) {
        // A 429 is the tracker's rate limit (120 requests a minute per
        // token), not a verdict on this entry. A long session's first flush
        // holds far more turns than that, and sending on into the limit made
        // every remaining entry "fail" with an attempt recorded against it
        // (measured on the Claude plugin: 1033 of 1146). So the flush stops
        // here — nothing more is sent, no entry is blamed — and says how long
        // to wait. Everything unsent stays pending: the next flush, or
        // `backfill --commit`'s own wait-and-continue loop, picks it up.
        if (error.status === 429) {
          return {
            booked, failed, errors,
            rateLimited: true,
            retryAfterSeconds: error.retryAfterSeconds ?? null,
            remaining: todo.length - index,
          }
        }
        failed += 1
        const status = error.status ?? null
        const message = error.message
        recordAttempt(sessionId, entry.turnUuid, { status, message })
        errors.push({ turnUuid: entry.turnUuid, status, message })
      }
    }
    return { booked, failed, errors }
  } finally {
    releaseLock()
  }
}

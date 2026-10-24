import { readDescription } from './spool.mjs'
import { readRepoDescription } from './config.mjs'

/**
 * Which description a booking carries. The conversation's own wins when it
 * says anything at all; otherwise the repo's default; otherwise none. A
 * whitespace-only value counts as unset, so a stray space can never shadow
 * the repo default with a blank row in the tracker.
 *
 * The winner is returned as stored, not trimmed: a session description that
 * was already in use keeps producing byte-identical payloads.
 */
export function resolveDescription(session, repo) {
  if (typeof session === 'string' && session.trim() !== '') return { effective: session, source: 'session' }
  if (typeof repo === 'string' && repo.trim() !== '') return { effective: repo, source: 'repo' }
  return { effective: '', source: 'none' }
}

/**
 * The one place a booking's description is decided — the Stop hook, the
 * backfill dry run and `status`/`description --show` all go through this, so
 * what is reported is always what would be booked. `cwd` finds the repo
 * config the same way the binding is found (upward, to the repo boundary).
 * Without a session id there is no conversation description to consult.
 */
export function effectiveDescription({ sessionId, cwd }) {
  const session = sessionId ? readDescription(sessionId) : ''
  const repo = readRepoDescription(cwd)
  return { session, repo, ...resolveDescription(session, repo) }
}

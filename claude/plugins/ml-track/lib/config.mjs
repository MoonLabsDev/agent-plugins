import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as paths from './paths.mjs'

const readJson = (file) => {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A truncated or hand-edited file is a user-fixable problem, not a crash
    // in a Stop hook that must never disrupt a turn.
    return null
  }
}

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Shared by readCredentials() and credentialsIssue() so they can never disagree. */
const loadCredentialParts = () => {
  const stored = readJson(paths.credentialsFile())
  return {
    token: process.env.MOONLABS_TRACKING_TOKEN || stored?.token,
    baseUrl: process.env.MOONLABS_TRACKING_URL || stored?.baseUrl,
  }
}

/**
 * Env beats file so CI can supply a token without writing one to disk.
 * A token in the environment with no URL still needs a base URL, so the file
 * is consulted for the half the environment did not supply.
 */
export function readCredentials() {
  const { token, baseUrl } = loadCredentialParts()
  if (!token || !baseUrl) return null
  return { token, baseUrl: baseUrl.replace(/\/+$/, '') }
}

/**
 * readCredentials() returns null both when nothing is configured and when a
 * token is present with no base URL to send it to — a task-1 review flagged
 * that the second case leaves a user with no explanation. This tells the two
 * situations apart without changing readCredentials()'s contract (existing
 * callers that treat null as "not logged in" keep working unchanged); a
 * caller that wants to explain *why* calls this too, only once readCredentials()
 * has already returned null.
 *
 * Returns 'missing-url' (a token exists but no base URL does), 'absent' (no
 * token — the ordinary "never logged in" case, regardless of a stray URL),
 * or null (credentials are actually fine; readCredentials() would not have
 * returned null).
 */
export function credentialsIssue() {
  const { token, baseUrl } = loadCredentialParts()
  if (token && !baseUrl) return 'missing-url'
  if (!token) return 'absent'
  return null
}

export function writeCredentials({ baseUrl, token }) {
  const file = paths.credentialsFile()
  writeJson(file, { baseUrl: baseUrl.replace(/\/+$/, ''), token })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows has no POSIX mode bits; the write still succeeded.
  }
}

/**
 * The directory whose `.moonlabs/tracking/config.json` governs `cwd`: `cwd`
 * itself or the nearest ancestor that has one, or null.
 *
 * `cwd` is not reliably the repo root. The Stop hook gets it from the hook
 * payload, and that is wherever the session's shell stands when the turn ends
 * — in a Unity repo, routinely `Assets/Scripts/...`. An exact-directory lookup
 * found no config there and the hook exited in silence, turn after turn.
 *
 * The search ends at the first directory that is itself a repository root
 * (has a `.git`): a different repo checked out inside a bound one's folder
 * must not inherit that binding and book its work onto someone else's project.
 */
function findRepoConfigDir(cwd) {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(paths.repoConfigFile(dir))) return dir
    if (existsSync(join(dir, '.git'))) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export const readRepoConfig = (cwd) => {
  const dir = findRepoConfigDir(cwd)
  return dir === null ? null : readJson(paths.repoConfigFile(dir))
}
// Writes go to the config that was FOUND, so `track --on` from a subdirectory
// flips the repo's one config instead of planting a second one beside it; only
// a repo with none yet gets a new file, at `cwd`.
export const writeRepoConfig = (cwd, value) =>
  writeJson(paths.repoConfigFile(findRepoConfigDir(cwd) ?? cwd), value)

/**
 * The binding file that `writeRepoConfig(cwd, …)` would write: the one found
 * upward from `cwd`, else a new one at `cwd`. Reported back after a repo
 * description is written, so the user knows which file to commit.
 */
export const repoConfigPath = (cwd) => paths.repoConfigFile(findRepoConfigDir(cwd) ?? cwd)

/**
 * The repo-wide default description lives in the binding file itself, beside
 * the project: a repo that always books to the same project under the same
 * heading (all internal repos onto "Internal Dev") sets it once, instead of
 * once per conversation. That file is committed, so the default is shared by
 * everyone working in the repo. A config written before this key existed
 * simply has none.
 */
export const readRepoDescription = (cwd) => {
  const description = readRepoConfig(cwd)?.description
  return typeof description === 'string' ? description : ''
}

// Read-modify-write so the binding beside it (client, project, enabled,
// idleThresholdSeconds) survives; an empty description removes the key
// rather than leaving `"description": ""` behind in a committed file.
export const writeRepoDescription = (cwd, description) => {
  const { description: _previous, ...rest } = readRepoConfig(cwd) ?? {}
  writeRepoConfig(cwd, description === '' ? rest : { ...rest, description })
}

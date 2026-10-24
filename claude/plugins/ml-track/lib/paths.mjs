import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Every filesystem location the plugin touches, in one module.
 *
 * The split is P3's: the TOKEN is user-global, so one login covers every repo
 * on the machine; the project BINDING is per-repo and carries no secret, so it
 * is safe to commit and a whole team books to the same project.
 *
 * MOONLABS_TRACKING_HOME, if set, replaces the real home directory as the
 * root every plugin file (credentials, spool, lock) is resolved under. This
 * exists so tests and CI can redirect the whole plugin away from a real
 * user's home directory instead of touching their live credentials or spool
 * — it is not a user-facing knob.
 */
/**
 * The host whose transcripts this build reads. Everything the plugin stores
 * is namespaced under it, because the TOKEN decides which agent the tracker
 * attributes time to: `agent_id` hangs off the credential and never comes
 * from a request body. A Claude build and a future Codex build are therefore
 * two different agents needing two different tokens, and a shared
 * credentials file would silently book one host's work to the other's agent.
 *
 * The spool follows for the same reason — its entries are keyed by THIS
 * host's session ids — and so does the flush lock, which is a bonus: two
 * hosts flushing at once are genuinely independent and no longer contend on
 * one lock.
 */
const HOST = 'claude'

const trackingBase = () =>
  process.env.MOONLABS_TRACKING_HOME
    ? join(process.env.MOONLABS_TRACKING_HOME, 'tracking')
    : join(homedir(), '.moonlabs', 'tracking')

const root = () => join(trackingBase(), HOST)

/**
 * Moves a pre-namespace layout (credentials and spool directly under
 * `tracking/`) into `tracking/<host>/`. Without this, adding the namespace
 * would silently orphan an existing login — the user would look logged in
 * one moment and not the next, and would have to hand over their token
 * again. Only ever moves INTO a destination that does not exist, so it can
 * never overwrite newer state, and it is a no-op once done.
 */
export function migrateLegacyLayout() {
  const base = trackingBase()
  const dest = root()
  for (const entry of ['credentials.json', 'spool']) {
    const from = join(base, entry)
    const to = join(dest, entry)
    if (!existsSync(from) || existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    try {
      renameSync(from, to)
    } catch {
      // A migration that cannot complete must never take the command down
      // with it: the caller simply sees no credentials and is told to log in.
    }
  }
}

export const credentialsFile = () => join(root(), 'credentials.json')
export const spoolDir = () => join(root(), 'spool')
export const spoolFile = (sessionId) => join(spoolDir(), `${sessionId}.jsonl`)
export const stateFile = (sessionId) => join(spoolDir(), `${sessionId}.state.json`)
export const lockFile = () => join(spoolDir(), 'flush.lock')
export const repoConfigFile = (cwd) => join(cwd, '.moonlabs', 'tracking', 'config.json')

/**
 * Claude Code's own transcript slug: the absolute cwd with every character
 * OUTSIDE [A-Za-z0-9] replaced by `-` — not just path separators and `:`.
 * Verified against real directory names under ~/.claude/projects/: a `.`
 * (`.claude` -> `-claude`), a space (`Goa India` -> `Goa-India`) and a
 * non-ASCII character all get replaced, same as any other non-alphanumeric.
 * Pure string manipulation — no filesystem, no `homedir()` — so it is
 * testable on its own.
 */
export const transcriptSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/**
 * Where Claude Code stores this session's transcript:
 * `<home>/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. This is NOT under
 * MOONLABS_TRACKING_HOME/root() — that override is for the plugin's own
 * storage (credentials, spool), not for Claude Code's transcript directory,
 * which is a different, unrelated tree even when the plugin's own root is
 * redirected. `homeDir` defaults to the real `homedir()` but can be injected
 * (a test does this) to keep the function pure and filesystem-free.
 */
export const transcriptPath = (cwd, sessionId, homeDir = homedir()) =>
  join(homeDir, '.claude', 'projects', transcriptSlug(cwd), `${sessionId}.jsonl`)

/**
 * Where Claude Code writes a subagent's OWN transcript while a session is
 * live: `<tmpdir>/claude/<cwd-slug>/<sessionId>/tasks/*.output` — one file
 * per dispatched Task, JSONL in the same shape as a main transcript
 * (measured: a real directory with 98 `.output` files at this exact path).
 *
 * NOT durable like `~/.claude/projects` — `os.tmpdir()` is cleared on the
 * OS's own schedule, so a backfill run weeks later may find this directory
 * gone entirely. Callers must tell that apart from "the directory exists and
 * is simply empty" (no subagents ran this session) — this function only
 * builds the path; it does not check existence, same division of labour as
 * `transcriptPath` above. `tmpDir` defaults to the real `tmpdir()` but can be
 * injected (a test does this) to keep the function pure and filesystem-free.
 */
export const subagentTasksDir = (cwd, sessionId, tmpDir = tmpdir()) =>
  join(tmpDir, 'claude', transcriptSlug(cwd), sessionId, 'tasks')

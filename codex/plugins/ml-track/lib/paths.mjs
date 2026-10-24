import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = () => process.env.MOONLABS_TRACKING_HOME ? join(process.env.MOONLABS_TRACKING_HOME, 'tracking', 'codex') : join(homedir(), '.moonlabs', 'tracking', 'codex')
// Legacy credentials belong to Claude; never migrate them into Codex.
export function migrateLegacyLayout() {}
export const credentialsFile = () => join(root(), 'credentials.json')
export const spoolDir = () => join(root(), 'spool')
export const spoolFile = (id) => join(spoolDir(), `${id}.jsonl`)
export const stateFile = (id) => join(spoolDir(), `${id}.state.json`)
export const lockFile = () => join(spoolDir(), 'flush.lock')
export const repoConfigFile = (cwd) => join(cwd, '.moonlabs', 'tracking', 'codex-config.json')
export const subagentTasksDir = (_cwd, id) => join(root(), 'unavailable-subagent-transcripts', id)
export function transcriptPath(_cwd, id, homeDir = homedir()) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid Codex session id')
  const base = process.env.CODEX_HOME || join(homeDir, '.codex')
  for (const name of ['sessions', 'archived_sessions']) {
    const dir = join(base, name)
    if (!existsSync(dir)) continue
    const found = readdirSync(dir, { recursive: true }).find(f => f.endsWith(`-${id}.jsonl`))
    if (found) return join(dir, found)
  }
  throw new Error('Codex rollout not found; supply --transcript <JSONL path>')
}

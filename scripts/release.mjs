#!/usr/bin/env node
// Publishes a finished plugin version into this marketplace.
//
//   node scripts/release.mjs <plugin> [--push]
//
// The plugins are developed in their own repositories (paths in plugins.json);
// this repo only ever receives released versions. For each build (claude,
// codex) the script runs the source's tests, refuses a dirty source checkout
// and a version that is not newer than the published one, copies the build
// (without tests and dev scripts), then commits and tags the release here.
// With --push it also pushes main and the tag.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [name, ...flags] = process.argv.slice(2)
const push = flags.includes('--push')

const sources = JSON.parse(readFileSync(join(root, 'plugins.json'), 'utf8'))
if (!name || !sources[name]) {
  console.error(`usage: node scripts/release.mjs <plugin> [--push]\nknown: ${Object.keys(sources).join(', ')}`)
  process.exit(1)
}

/** Where each build lives here, and which manifest carries its version. */
const BUILDS = {
  claude: { dest: join(root, 'claude', 'plugins', name), manifest: '.claude-plugin/plugin.json' },
  codex: { dest: join(root, 'codex', 'plugins', name), manifest: '.codex-plugin/plugin.json' },
}
/** Never shipped: tests and the source repo's own dev helpers. */
const EXCLUDE = new Set(['test', 'update.mjs', 'node_modules'])

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const version = (dir, manifest) => {
  const file = join(dir, manifest)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null
}
/** Numeric compare of the x.y.z core; build metadata (+codex...) is ignored. */
const newer = (a, b) => {
  if (!b) return true
  const parse = (v) => v.split('+')[0].split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return a !== b
}
const fail = (message) => {
  console.error(`release refused: ${message}`)
  process.exit(1)
}

if (run('git', ['status', '--porcelain'], root) !== '') fail('this marketplace repo has uncommitted changes')

const released = []
for (const [build, { dest, manifest }] of Object.entries(BUILDS)) {
  const src = sources[name][build]
  if (!src) continue
  if (!existsSync(src)) fail(`${build} source not found: ${src}`)
  if (run('git', ['status', '--porcelain', '--', '.'], src) !== '') fail(`${build} source has uncommitted changes: ${src}`)

  const next = version(src, manifest)
  const current = version(dest, manifest)
  if (!next) fail(`${build} source has no version in ${manifest}`)
  if (!newer(next, current)) fail(`${build} ${next} is not newer than the published ${current}`)

  const tests = join(src, 'test')
  if (existsSync(tests)) {
    const files = readdirSync(tests).filter((f) => f.endsWith('.test.mjs')).map((f) => join(tests, f))
    console.log(`${build}: running ${files.length} test files`)
    execFileSync(process.execPath, ['--test', ...files], { cwd: src, stdio: 'inherit' })
  }

  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true, filter: (path) => !EXCLUDE.has(path.split(/[\\/]/).pop()) })
  const sourceRev = run('git', ['rev-parse', '--short', 'HEAD'], src)
  released.push({ build, version: next, sourceRev })
  console.log(`${build}: ${current ?? 'new'} -> ${next} (source ${sourceRev})`)
}

if (released.length === 0) fail(`no builds configured for ${name}`)

const tagVersion = released[0].version.split('+')[0]
const tag = `${name}-v${tagVersion}`
const body = released.map((r) => `${r.build}: ${r.version} (source ${r.sourceRev})`).join('\n')
run('git', ['add', '-A'], root)
run('git', ['commit', '-m', `${name} ${tagVersion}\n\n${body}`], root)
run('git', ['tag', tag], root)
console.log(`committed and tagged ${tag}`)

if (push) {
  run('git', ['push', 'origin', 'HEAD'], root)
  run('git', ['push', 'origin', tag], root)
  console.log('pushed')
} else {
  console.log('not pushed — run again with --push, or: git push origin HEAD --tags')
}

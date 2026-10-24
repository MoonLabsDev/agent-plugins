# MoonLabs agent plugins

One marketplace for Claude Code and Codex. Each plugin is installed on its own.

| Plugin | Claude Code | Codex |
| --- | --- | --- |
| `ml-track` — books agent time and token cost onto a MoonLabs time-tracker project | `claude/plugins/ml-track` | `codex/plugins/ml-track` |

## Install

### Claude Code

```bash
claude plugin marketplace add MoonLabsDev/agent-plugins
claude plugin install ml-track@moonlabs
```

Restart Claude Code, then log in once per machine:

```
/ml-track:login --token <mlt_… token> --url https://time.moon-labs.io
```

Bind a repository with `/ml-track:project`; set a default description for all
conversations in that repository with `/ml-track:repo-description <text>`.

Updates: `claude plugin marketplace update moonlabs && claude plugin update ml-track@moonlabs`.

### Codex

```bash
codex plugin marketplace add MoonLabsDev/agent-plugins
codex plugin add ml-track@moonlabs
```

Start a new Codex task, trust the plugin hooks with `/hooks`, then use the
`login` skill with a **Codex agent token** (not the Claude one: the server
attributes bookings by token).

## Releasing (maintainers)

Plugins are developed in their own repositories (`plugins.json`); this repo only
receives released versions:

```bash
node scripts/release.mjs ml-track --push
```

The script runs the source tests, refuses a dirty source or a version that is
not newer than the published one, copies both builds (without tests and dev
scripts), commits, tags `<plugin>-v<version>` and pushes.

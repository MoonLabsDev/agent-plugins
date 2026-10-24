---
description: Bind this repository to a client project for time tracking
---

List what is available:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" project --list
```

If the JSON has `"ok": false`, tell the user and do not proceed.

For `not logged in` specifically, do not stop at "run /ml-track:login". The
credentials file is per machine AND per host, at
`~/.moonlabs/tracking/claude/credentials.json`. If the user believes they are
already logged in, the likeliest cause is an INSTALLED plugin copy older than
that path: versions before 0.1.2 look one directory up, at
`~/.moonlabs/tracking/credentials.json`, and stop finding the login once it
has been moved. Tell them to run `node <repo>/plugin/claude/ml-track/update.mjs`
and restart Claude Code, before asking them to log in again — logging in again
would mean handing over a token that is already stored and working.

Otherwise present the projects to the user grouped by client, as a short
numbered list. Ask which one this repository should book to. Then set it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" project --set <projectId>
```

Then print the binding back as a verification table, from the `--set`
response and not from what the user asked for — the point is to show what was
actually written:

| | |
|---|---|
| Kunde | `client.name` |
| Projekt | `project.name` |
| Datei | `<repo>/.moonlabs/tracking/config.json` |
| Tracking | `tracking` from the response: `an` — every turn is booked from now on — or `aus, bis /ml-track:track on` |

A fresh binding turns tracking on; a repo that was already bound keeps
whatever it had, so a deliberate `/ml-track:track off` survives a re-bind. If
`tracking` is `false`, say so plainly — a bound repo that books nothing looks
exactly like a working one until someone checks the tracker.

This matters because two of the user's clients have projects with the SAME
name (`Support`, `Website` both exist under more than one client), so a
project name alone never proves the right one was picked. Naming the client
back is what makes the confirmation worth reading.

Then say that the written file holds no token and is safe to commit — and
that committing it is what makes a whole team book to the same project.

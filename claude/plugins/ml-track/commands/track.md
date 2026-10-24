---
description: Turn ml-track's automatic per-turn booking on or off for this repo
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" track --$ARGUMENTS
```

The argument is `on` or `off`. It is passed through whole rather than by
position: the numbered placeholders resolve one word late here, so a
single-word argument like `on` came through empty and produced a bare `--`.

With no argument, report the current state instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" track
```

Confirm the new state and name the client and project it books to, so the user
can see at a glance that it is the right one.

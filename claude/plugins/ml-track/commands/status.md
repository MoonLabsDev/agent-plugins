---
description: Show ml-track's configuration and what it has booked
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" status --session "${CLAUDE_SESSION_ID:-}"
```

Render the result as a short summary: whether logged in and against which URL,
which client and project this repo books to, whether tracking is on, the
descriptions, and how many turns are pending versus booked.

For the descriptions, show this conversation's (`description`), the repo
default (`repoDescription`), and which one bookings made now carry
(`effectiveDescription`, from `descriptionSource`: `session`, `repo`, or
`none` for no description at all). Point at `/ml-track:description` to set the
conversation's own and `/ml-track:repo-description` to set the repo default.

If `loggedIn` is `false`, check `credentialsIssue` before saying anything else,
since it distinguishes two different situations:
- `"absent"` — nothing is configured. Point the user at `/ml-track:login`.
- `"missing-url"` — a token is stored or set in the environment, but there is
  no base URL to send it to. Tell the user this plainly (a bare "not logged
  in" would be misleading here, since a token does exist) and point them at
  `/ml-track:login` with `--url` supplied.

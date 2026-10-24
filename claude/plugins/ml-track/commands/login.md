---
description: Store the MoonLabs time-tracker API token for this machine
---

Run the plugin CLI to validate and store the token:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" login $ARGUMENTS
```

The command line above passes the user's words through verbatim, on purpose.
The numbered placeholders were tried first and proved to be off by one here:
the first of them resolved to the SECOND word, which silently shifted a bare
token into its neighbour's slot and attempted a login with the wrong value.
Do not change it back to numbered placeholders.

(Written without naming those placeholders literally: substitution applies to
this whole file, not only to the code block, so spelling them out here would
replace them with the user's own arguments mid-sentence — turning this
warning into nonsense and repeating the token in the rendered instructions.)

## If the JSON has `"ok": false`

Report the `error` message and, if present, the `status` code. Do not guess at
a cause beyond what the message says.

Then **always print the correct syntax**, so the user can retry without
looking it up:

```
/ml-track:login --token <token> --url <base-url>
```

Both flags are named; the order does not matter. `--url` may be omitted, in
which case `http://localhost:3000` is used — say so, because a user whose
tracker runs on another port will otherwise see a confusing connection error
rather than realising the default was wrong.

Add the one hint that matches the failure, and no more:

- **`status` 401** — the token is wrong, expired or revoked. It is not a URL
  problem: a 401 means the server was reached and rejected the credential.
- **`status` is `null`** (a network error) — the server was not reached.
  The `--url` is wrong or the tracker is not running. Name the `baseUrl`
  field from the JSON: a network failure's own message is bare (`fetch
  failed`) and names no URL, and a wrong `--url` looks exactly like a stopped
  server until the user sees which one was tried.
- **`missing --token`** — the flag itself was omitted. This is the case the
  syntax line above fixes.

## If the JSON has `"ok": true`

Print the stored login back as verification, as a small table: the company
and user it authenticated as, the `role`, the granted `scopes`, and the
`agent` (its `name` and `provider`, or `null`).

Also state plainly which base URL is now stored, and that every later call —
including the automatic background bookings — will use it. The user just
typed a URL and deserves to see it echoed back rather than assumed.

**If `agent` is null, say so explicitly.** The server rejects both
`active_seconds` and `costs` from a non-agent credential, so such a token
creates no record at all — not a record with a missing cost. Tell them to
re-mint the token at `/settings/tokens` with the agent selector and the
`records:write`, `costs:write`, `projects:read` and `clients:read` scopes.

A non-null `agent` is the confirmation that booking will actually work; say
that too, and name the agent, so a successful login is not ambiguous.

## Always

**Never echo the token itself back to the user**, in the success case, the
failure case, or the syntax hint — write `<token>`, never the real value.

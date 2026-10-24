---
description: Show or set the default description ml-track books with, for every conversation in this repo
---

The repo description is the DEFAULT for every conversation in this repository
that sets none of its own with `/ml-track:description`. It lives in the repo's
binding file, `.moonlabs/tracking/config.json` — the same file
`/ml-track:project` writes the project to — and that file is meant to be
committed, so the repo description is shared with everyone working in this
repository. Say so whenever it is set or cleared.

A booking uses the conversation's own description when it is set and not just
whitespace; otherwise this repo default; otherwise none. Every response
reports `repoDescription`, this conversation's `description`, and
`effectiveDescription` with `descriptionSource` (`session`, `repo` or `none`)
— the one bookings made from now on carry.

## If the user supplied no text

Report the current repo description and change nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --repo --show --session "${CLAUDE_SESSION_ID}"
```

Run this branch, not the set below. Say what the repo description is (or that
none is set), and which description this conversation's bookings actually use
— if `descriptionSource` is `session`, this conversation's own overrides the
repo default.

## If the user supplied only `--clear`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --repo --clear --session "${CLAUDE_SESSION_ID}"
```

## If the user supplied text

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --repo --session "${CLAUDE_SESSION_ID}" --set "$ARGUMENTS"
```

The command line above passes the user's words through whole, on purpose. The
numbered placeholders were tried first and proved off by one here: the first
resolved to the SECOND word, so a description lost its first word and the rest
shifted. Do not change it back to numbered placeholders.

(Written without naming those placeholders literally: substitution rewrites
this whole file, not only its code blocks, so spelling one out in a sentence
replaces it with the user's own words mid-paragraph.)

Unlike the conversation's description, an empty text is refused rather than
taken as a clear: wiping a shared value takes `--clear`.

## After a set or clear

Report `configFile` — the binding file that was written (found upward from
here, or created at the current directory if the repo had none) — and remind
the user to commit it if the team should book with the same default. If
`descriptionSource` is `session`, add that this conversation keeps booking
with its own description until it is cleared with
`/ml-track:description --clear`.

## Always

Every response carries `tracking`. If it is `false`, say so plainly and first:
this repository books NOTHING right now, so the description will not reach the
tracker until `/ml-track:track on` is run (or the turns are booked later with
`/ml-track:backfill`). Do not let a successful set read as "this repository is
being tracked".

The repo description applies to turns booked from now on: the description is
resolved when a turn is spooled, and turns already spooled keep the one they
were spooled with, so changing it does not rewrite history — say so if the
user seems to expect otherwise.

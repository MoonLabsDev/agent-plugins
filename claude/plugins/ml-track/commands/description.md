---
description: Show or set the description ml-track books with, for this conversation
---

The description belongs to THIS conversation, not to the repository. One repo
hosts many conversations, and each keeps its own — so setting one here never
changes what another conversation books with.

A repository can also carry a default, set with `/ml-track:repo-description`.
A booking uses this conversation's description when it is set and not just
whitespace; otherwise the repo default; otherwise none. Every response reports
all three: `description` (this conversation's), `repoDescription`, and
`effectiveDescription` with `descriptionSource` (`session`, `repo` or `none`)
— the one bookings made from now on carry.

## If the user supplied no text

Report the current description and change nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --session "${CLAUDE_SESSION_ID}" --show
```

Run this branch, not the one below. The set command with an empty argument
would store an empty description — a silent wipe, when the user typed the bare
command expecting to be told what is currently set.

Say what the description is (or that none is set), say it applies to this
conversation only, and say which description bookings actually use — when this
conversation has none, that is the repo default if one is set.

## If the user supplied text

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --session "${CLAUDE_SESSION_ID}" --set "$ARGUMENTS"
```

The command line above passes the user's words through whole, on purpose. The
numbered placeholders were tried first and proved off by one here: the first
resolved to the SECOND word, so a description lost its first word and the rest
shifted. Do not change it back to numbered placeholders.

(Written without naming those placeholders literally: substitution rewrites
this whole file, not only its code blocks, so spelling one out in a sentence
replaces it with the user's own words mid-paragraph.)

If the user's text starts with `--repo`, they meant the repo default: run
`/ml-track:repo-description`'s branches instead (the CLI also accepts
`description --repo`, but that command is the documented way).

## To clear it

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ml-track.mjs" description --session "${CLAUDE_SESSION_ID}" --clear
```

If a repo default exists, say that bookings now fall back to it.

## Always

Every response carries `tracking`. If it is `false`, say so plainly and first:
this repository books NOTHING right now, so the description will not reach the
tracker until `/ml-track:track on` is run (or the turns are booked later with
`/ml-track:backfill`). Do not let a successful set read as "this conversation
is being tracked" — that misreading is how whole sessions went unbooked.

The description is empty by default and sticks for the rest of this
conversation. It applies to turns booked from now on: the description is
resolved when a turn is spooled, and turns already spooled keep the one they
were spooled with, so changing it does not rewrite history — say so if the
user seems to expect otherwise.

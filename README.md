# pr-tracker

A Claude Code mod that keeps a live pane of the GitHub pull requests a session works on: state, review, mergeability and CI progress, refreshed through `gh`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pr-tracker --marketplace JSmithRobotics/claude-pr-tracker
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Needs the [GitHub CLI](https://cli.github.com/) installed and logged in (`gh auth login`).

## Use

- `/prs` opens the pane. In classic (main-screen) mode it opens as one row above the prompt with the PRs side by side (status, number, CI tally, `✕`); `‹`/`›` (`h`/`l`) scroll it sideways and `✕` (`x`) closes it. In fullscreen it docks on the right of the transcript from 110 columns, and closes if the terminal narrows below that; the desktop app docks it when no terminal is attached.
- In fullscreen the summary sits clickable at the end of the hint line under the prompt (`⌥ PRs 3 open · 1 failing`): click it to open the pane, click again to close it.
- In the pane, click a PR number to open it on GitHub, `checks` for its checks page, `↻` to refetch it and `✕` to stop tracking it; the header has `refresh` (`r`) and `close` (`x`), and the done list `clear`.
- Docked narrower than 48 columns, the pane shows one line per PR (status, number, CI tally, `✕`) under a single `⌥ PRs ✕` row.
- PRs are picked up from the session's own shell commands: `gh pr create`, `gh pr view|checks|merge|ready|edit|comment|diff|review|reopen|close <n>`, and any `github.com/<owner>/<repo>/pull/<n>` URL.
- `/prs add <n | owner/repo#n | url>`, `/prs remove <n>`, `/prs clear`, `/prs refresh`.
- Claude, and so any skill, can call the `mcp__pr-tracker__track_prs` tool: `{ "prs": ["123", "owner/name#45", "https://github.com/o/r/pull/6"] }` tracks them, adding `"untrack": true` removes them. It costs no GitHub request; the PRs join the next batched fetch. In a skill, a line such as "Call `mcp__pr-tracker__track_prs` with the PRs you create or review" is enough.

Each open PR is a card coloured by its CI health, sorted so failing and conflicting PRs come first, with a segmented CI bar and the failing or running check names. Merged and closed PRs fold into a list at the bottom. When the cards do not fit, the rest drop to one line each (the two most urgent always stay cards) and the pane scrolls: `ctrl+x tab` to focus it, then the arrow keys.

Stacked PRs stay together: a tracked PR whose base branch is another tracked PR's head (same repo, not from a fork) is listed right after it, bottom first, so in merge order. The stack sorts by its most urgent PR. The pane heads it `stack on main: #12 → #13 → #14` (two PRs on #12 read `#12 → #13, #12 → #15`), the narrow pane brackets it with `┌ ├ └`, and the classic row joins its chips with `→`. Only tracked PRs are linked: track every PR of a stack to see all of it.

Outside fullscreen the status line summarises the open PRs (`PRs 3 open · 1 failing · 2 running`). The tracked list lasts for the session.

## GitHub requests

- Each fetch is one `gh api graphql` call covering every due PR, whatever the repo. The repo of the working directory is the one gh resolves (a `gh repo set-default` choice, else the `upstream`, `github` or `origin` remote), read from git's config, and a PR from `gh pr create` from that command's output, so neither costs a request.
- PRs with running checks are refetched every minute, other open PRs every 5 minutes, merged and closed ones not at all. With the pane closed and no prompt or Bash call for 10 minutes, that slows to every 5 and 25 minutes. A PR GitHub can't answer (a typo, a deleted fork) is retried after 1, 2, 4, 8 … minutes, at most hourly; gh being offline or logged out doesn't count against a PR. PRs named within a second of each other share one fetch. `refresh` in the pane, its `↻` and `/prs refresh` fetch at once.
- Every Claude session on the machine shares one budget, `requestsPerHour` (default 60), and one cache of results. A PR another session fetched recently is not fetched again. When GitHub says the limit is spent, every session pauses until its reset, and the pane header says `gh paused 12m`.
- The shared files live in `$CLAUDE_PR_TRACKER_DIR`, else `%LOCALAPPDATA%\claude-pr-tracker` on Windows, else `$XDG_CACHE_HOME/claude-pr-tracker` or `~/.cache/claude-pr-tracker`.

Settings (`/plugin` → pr-tracker, or `pluginConfigs` in settings): `requestsPerHour`, and `daemonCommand`.

### Daemon protocol

If `daemonCommand` (default `pr-tracker-daemon`) is on the `PATH` and `<command> ping` exits 0 at session start, it does all the fetching instead of the built-in coordinator. `<command> fetch` reads a request on stdin and prints the response on stdout, both JSON, as typed in [`types/index.d.ts`](types/index.d.ts) (`FetchRequest`, `FetchResponse`):

```json
{ "version": 1, "requestsPerHour": 60, "prs": [{ "key": "owner/name#123", "maxAgeMs": 60000 }] }
```

```json
{ "prs": { "owner/name#123": { "fetchedAt": 1760000000000, "data": { "title": "...", "state": "OPEN", "pass": 3, "...": "..." } } },
  "limitedUntil": 1760000600000, "reason": "GitHub rate limit" }
```

- The daemon serves every session, so it enforces `requestsPerHour` across them and shares results between them.
- A PR with no result yet (held back, or not fetched) is left out; one GitHub could not answer carries an `error` instead of `data`. `limitedUntil` is set only while fetching is held back.
- When `fetch` fails, exits non-zero or prints something that is not a response of that shape, the session falls back to the built-in coordinator for that fetch.
- The command is run directly, not through a shell, so on Windows it must be an executable (`.exe`), not a `.cmd` or `.bat` shim.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, see [LICENSE](LICENSE).

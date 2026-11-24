# mend-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nugian10/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/nugian10/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It reads a patch from a file or
stdin and applies it to a tree of text files, atomically: every file changes,
or nothing does. It understands the formats AI coding agents actually emit —
unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits —
and detects which one it was given. Fuzzy context matching (two tiers of
whitespace tolerance, `--strict` for exact only), dry-run checks with
`--check`, and one-line-per-file reporting (`A`/`D`/`M`/`R` rows plus
`ok: n files`).

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or `-`/omitted to read stdin. Flags:
`--format=unified|search_replace|v4a|json` to force a format, `--check` to
validate without writing, `--strict` for exact matching only.

## The formats

- **Unified diff** — `diff --git` sections or `---`/`+++` pairs, with hunks,
  context lines, and `\ No newline at end of file`.
- **SEARCH/REPLACE** — fenced blocks with a path line before each
  `------- SEARCH` marker.
- **V4A** — `*** Begin Patch` / `*** Add File:` / `*** Delete File:` /
  `*** Update File:` / `*** Move to:` / `*** End Patch`.
- **JSON** — an array of edit objects, or one JSON object per line.

All 100 practice checks in the kit pass, and the trial harness reports 100/100.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c9snmccq&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

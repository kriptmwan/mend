# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kriptmwan/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kriptmwan/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four formats
models use, to a tree of text files — every file changed or nothing changed:

- **unified diffs**, with wrong line numbers: each hunk finds its lines by content at three
  matching tiers (exact, trailing whitespace, leading and trailing whitespace with
  re-indentation), taking the occurrence nearest the header line, and handles creates,
  deletes and moves;
- **SEARCH/REPLACE blocks**, which must match exactly once or fail ambiguous;
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with text anchors, a cursor and
  end-of-file chunks;
- **text-editor tool calls as JSON** (array or JSON Lines): `create`, `str_replace`, `insert`.

It reads a patch from a file or standard input, prints what it changed (`A`/`D`/`M`/`R` lines
plus `ok: <n> files`) or why it failed, and exits 0, 1 or 2 as SPEC.md says. CRLF files keep
their line breaks, files without a final line break keep that, and `--check` reports what
would change without writing anything. Node 22 and its standard library alone — no
dependencies, no network, no model calls.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`),
`--check` (report without writing), `--strict` (exact matching only, tier 0).
`PATCH` is the patch file, or `-`/absent for standard input.

```sh
node main.ts fix.patch
node main.ts --check --format=v4a change.diff
cat edit.patch | node main.ts -
```

`SPEC.md` is the whole contract. `check.ts` runs the 100 public practice checks
(`node check.ts <practice.json>`); `tests/extra.mjs` runs 43 further checks for sentences
of the spec the practice set does not show. Practice score: 1000 (100/100).

---

<sub>Entered on [make.fun](https://make.fun/?ref=emz2619t&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

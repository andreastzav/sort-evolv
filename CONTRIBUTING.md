# Contributing

Thanks for taking a look at `sort-evolv`. This repository is an experimental research harness for evolving stable JavaScript sorting implementations with an LLM in the loop. Contributions are welcome when they preserve the project invariant: correctness first, measured performance second, and orchestrator-owned evolution state.

## Development Setup

Requirements:

- Node.js with ES module support
- Git
- PowerShell on Windows, or equivalent shell commands on Linux/macOS

There are no npm dependencies right now, so a fresh clone can be checked directly:

```powershell
node unit_tests_cli.js --sorting codexsort
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js status
```

## Sorter API

Sorter modules expose a stable sorting function with this shape:

```js
sortFn(array, compareFn)
```

Rules for sorter implementations:

- Preserve stable sort behavior.
- Do not lose, duplicate, or mutate values outside the expected in-place sort behavior.
- Be deterministic for the same input and comparator.
- Do not use native `Array.prototype.sort` as an internal sorting path in evolved sorter implementations.
- Keep baseline files immutable.

## Working on Existing Sorters

For active evolution, use the orchestrator commands. Do not manually create snapshot files or update metadata.

Canonical loop:

```powershell
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js next
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js prepare
# edit codexsort.js once, deliberately
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js auto-record --idea "short idea" --display-preset medium
```

`auto-record` owns the syntax check, unit tests, benchmark, winner/loser decision, snapshot persistence, and progress logs.

Important constraints:

- Run unit tests before standalone benchmarks.
- Never run more than one benchmark process at a time.
- Keep the decision suite fixed to `quick,medium,balanced` unless you are doing a separate one-off benchmark.
- Treat syntax or unit-test failures as non-strategic attempts; fix them without manually recording a snapshot.

## Adding a New Sorter

A new sorter normally needs:

1. A working sorter file at the repository root, for example `mysort.js`.
2. A baseline file, for example `mysort_original.js` or another explicit `--base-file`.
3. A first unit-test run:

```powershell
node unit_tests_cli.js --sorting mysort
```

By default, sorter IDs are profile-derived. `--sorting mysort` maps to:

- working file: `mysort.js`
- baseline file: `mysort_original.js`
- snapshots: `algorithms/mysort/snapshots/<base-stem>/`
- evolution metadata: `algorithms/mysort/evolution/<base-stem>/`

If a sorter needs non-default paths or labels, update the profile logic in `sorting_profile_core.js` and document the new behavior in `README.md`.

## Useful Commands

Status and current target:

```powershell
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js status
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js next
```

Correctness:

```powershell
node unit_tests_cli.js --sorting codexsort
node sorting_compat_cli.js --sorting codexsort --runs 1
```

Benchmark current working file:

```powershell
node benchmarks_cli.js --sorting codexsort --base-file codexsort_initial.js --presets quick,medium,balanced --candidate-file codexsort.js
```

Render graph:

```powershell
node evolution_graph_cli.js --sorting codexsort --base-file codexsort_initial.js
```

## Pull Request Checklist

Before opening a PR or committing a meaningful change:

- Run `node unit_tests_cli.js --sorting codexsort` for harness or active sorter changes.
- Run the relevant sorter-specific unit tests if you changed another sorter.
- Run a benchmark only when behavior or performance-sensitive code changed.
- Keep generated graph files, binary table caches, and one-off benchmark reports out of git.
- Include the snapshot ID and winner/loser result in the PR description when the change records an evolution batch.

## Documentation Changes

Documentation should keep the command canon in sync with `AGENTS.md`. If branch limits, decision thresholds, or orchestrator policy values change, update both `AGENTS.md` and `orchestrator_policy_core.js` in the same change.

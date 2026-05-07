# sort-evolv

LLM-assisted algorithm evolution playground for stable JavaScript sorting functions.

`sort-evolv` is designed for Codex/LLM-in-the-loop research. Codex acts as the iterative researcher-engineer: it asks the orchestrator for the next branch, prepares the candidate, makes one deliberate code change, runs correctness gates and benchmarks, records the result, then reasons from the new data before the next iteration.

The project benchmarks sorter implementations with a shared API:

```js
sortFn(array, compareFn)
```

The current active research tree is `codexsort`, with historical `timsort` evolution data kept for comparison.

## Purpose

`sort-evolv` is built to iterate on sorting algorithms experimentally:

- keep correctness as a hard gate
- compare candidates against a fixed anchor
- preserve snapshots and benchmark metadata
- explore implementation tweaks and larger algorithmic changes
- use deterministic benchmark datasets generated from fixed seeds

The system is sorter-independent: every command selects the active sorter with `--sorting <id>`.

## Core Concept

Evolution is managed by `sorting_experiments_cli.js`.

Each iteration is:

1. Ask the orchestrator for the next target.
2. Prepare the working sorter file from that target.
3. Make one deliberate code edit.
4. Run `auto-record`, which performs syntax check, unit tests, benchmark, and snapshot persistence.

The decision metric is normalized p50 score:

- lower score is better
- candidate is compared against native sort per case
- preset scores are geomeans
- suite score is the geomean of `quick`, `medium`, and `balanced`

A candidate becomes a winner when:

- overall improvement vs anchor is at least `1.00%`
- no preset regresses worse than `0.50%`

## Search Policy

The orchestrator uses Local Beam DFS.

Winners own real child slots. A losing child starts a loser family. Inside a loser family, the planner can continue from the latest promising loser or branch from an earlier promising loser instead of blindly mutating a damaged child.

Default limits:

```text
MAX_ROOT_BRANCHES = 6
MAX_CHILD_VARIANTS_PER_WINNER = 3
MAX_SPECULATIVE_LOSSES = 5
LOCAL_BEAM_WIDTH = 2
MAX_CHILDREN_PER_LOSER = 2
MAX_UGLY_CONTINUATIONS_PER_FAMILY = 1
```

The authoritative policy values live in `orchestrator_policy_core.js`.

## Main Directories

```text
.
|-- algorithms/
|   |-- codexsort/
|   |   |-- evolution/
|   |   `-- snapshots/
|   `-- timsort/
|       |-- evolution/
|       `-- snapshots/
|-- *_cli.js
|-- *_core.js
|-- codexsort.js
|-- timsort.js
`-- AGENTS.md
```

Important paths:

- `algorithms/<id>/snapshots/<base-stem>/` stores immutable candidate snapshots.
- `algorithms/<id>/evolution/<base-stem>/` stores metadata and progress logs.
- `algorithms/<id>/tables/` is ignored; benchmarks generate deterministic rows from seeds instead of loading binary tables.
- `AGENTS.md` stores operational rules for autonomous evolution.

## Current Sorters

```text
codexsort.js          active experimental sorter
codexsort_initial.js  root baseline for the codexsort evolution tree
codexsort_original.js original baseline copy

timsort.js            TimSort implementation
timsort_base_0120.js  TimSort baseline for one historical tree
timsort_original.js   TimSort original baseline
```

## Requirements

- Node.js with ES module support
- Codex or another LLM coding agent for autonomous/assisted evolution
- Git for version control
- PowerShell on Windows, or shell equivalents on Linux/macOS

There are no npm dependencies at the moment.

## Using With Codex

Open this repository in Codex and ask it to continue an evolution tree using the orchestrator. A good starting prompt is:

```text
Continue evolving codexsort from the current orchestrator target.
Use AGENTS.md rules.
Run: next -> prepare -> one deliberate code edit -> auto-record.
Do not run more than one benchmark process at a time.
Report the new snapshot, winner/loser status, preset deltas, and next target.
```

Codex should use commands like:

```powershell
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js next
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js prepare
# Codex edits codexsort.js
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js auto-record --idea "short idea" --display-preset medium
```

The human can steer strategy, but Codex should let the orchestrator own snapshot selection and persistence.

## Basic Usage

All evolution commands require:

```text
--sorting <id>
--base-file <base>.js
```

Example for the active CodexSort tree:

```powershell
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js status
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js next
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js list --limit 10
```

## Evolution Loop

Canonical loop:

```powershell
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js next
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js prepare
# edit codexsort.js
node sorting_experiments_cli.js --sorting codexsort --base-file codexsort_initial.js auto-record --idea "short idea" --display-preset medium
```

Do not manually create snapshots. The orchestrator owns snapshot numbering and metadata.

## Unit Tests

```powershell
node unit_tests_cli.js --sorting codexsort
node unit_tests_cli.js --sorting timsort
```

Correctness gates include stability, deterministic comparator behavior, no missing/duplicated elements, and benchmark matrix parity with native sort.

## Benchmarks

Independent benchmark of the current working file:

```powershell
node benchmarks_cli.js --sorting codexsort --base-file codexsort_initial.js --presets quick,medium,balanced --candidate-file codexsort.js
```

Independent benchmark of a snapshot:

```powershell
node benchmarks_cli.js --sorting codexsort --base-file codexsort_initial.js --presets quick,medium,balanced --candidate-file algorithms/codexsort/snapshots/codexsort_initial/codexsort_0020.js
```

Three-way comparison with native, original, and one or more candidates:

```powershell
node benchmark_search_cli.js --sorting codexsort --base-file codexsort_initial.js --candidates algorithms/codexsort/snapshots/codexsort_initial/codexsort_0020.js,algorithms/timsort/snapshots/timsort_original/timsort_0077.js --presets quick,medium,balanced
```

Benchmark presets:

```text
quick    10,000 rows, seed 20260321
medium   50,000 rows, seed 20260322
balanced 100,000 rows, seed 20260323
large    250,000 rows, seed 20260324
huge     1,000,000 rows, seed 20260325
```

Rows are generated in memory from deterministic seeds. Binary `.bin` table files are not used by normal benchmark/evolution runs.

Important rule: do not run more than one benchmark process at the same time.

## Graphs

Render an evolution graph:

```powershell
node evolution_graph_cli.js --sorting codexsort --base-file codexsort_initial.js
```

Rendered `.svg` and `.html` files are ignored because they can be regenerated from the iteration metadata.

## Compatibility Smoke Tests

Single sorter:

```powershell
node sorting_compat_cli.js --sorting codexsort --runs 1
```

Multiple sorters:

```powershell
node sorting_matrix_smoke_cli.js --sortings codexsort,timsort --runs 1
```

## Git Notes

The repository tracks:

- source files
- active sorter files
- evolution metadata
- immutable snapshots
- progress logs

The repository ignores:

- generated benchmark reports
- rendered graph files
- fake simulator outputs
- generated binary table caches

After a meaningful evolution batch:

```powershell
git status
git add .
git commit -m "Describe the evolution batch"
```

## Safety Rules

- Unit tests before benchmarks.
- Never use native `Array.prototype.sort` as an internal sorter path for evolved sorters.
- Keep baseline files immutable.
- Use orchestrator commands for evolution state changes.
- Do not run blind mutation loops; each iteration should have one intentional code edit.

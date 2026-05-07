## Autonomous Sorting Iteration Policy

- Codex runs the optimization loop autonomously (no user manual steps unless blocked).
- Use orchestrator commands only (`next`, `prepare`, `auto-record`), not ad-hoc snapshot tracking.
- For active sorting evolution, always use AI-in-the-loop iteration. Do not run blind scripted mutation loops. Each iteration must be: next -> prepare -> one deliberate manual code edit by Codex -> auto-record, then reassess from fresh results before the next edit.

## Sorting Research Mode (Algorithm + Invariants Allowed)

- You may change the active working sorter file at both levels:
  1. implementation-level optimizations
  2. algorithm/invariant logic (e.g. run stack rules, merge-collapse conditions, minrun, galloping, merge/temp-buffer strategy)
- Explore diverse ideas: both safe implementation tweaks and algorithm/invariant changes when needed.
- Thinking out of the box is encouraged, no pain no gain, no risk no reward.
- If micro-optimizations stall, propose and test algorithmic variants. Think well of the changes, don't focus necessarily on micro optimizations.
- Workload-adaptive branch splitting is allowed: if different ideas win for different preset groups or data patterns, keep separate specialized paths alive instead of forcing one universal winner too early.
- Mixing other strategies like e.g. count sorting for low cardinality and other ideas and combinations, or using ideas from quicksort, radix sort, bubble sort, bucket sort are allowed as well.
- Mixing with other strategies must preserve stable comparator semantics
- Never use native `Array.prototype.sort` as an actual internal sorting path inside an evolved sorter.
- Cross-anchor replay is allowed: you can periodically retry previously losing ideas (from any branch/root) as fresh variants on the current winner anchor, because anchor context can change outcomes; label such attempts as replay:<source_snapshot> for traceability.
- Do not use replays too often: max one replay every 4 iterations. In a single chain, do not use the same replay idea more than 3 times
- Multi-change iterations are allowed only as explicitly labeled combo trials on a separate branch, and no more than one combo trial every 6 iterations.
- Keep the active baseline sorter file immutable.

### Correctness Requirements (hard gates)

- Stable sort behavior.
- No missing/duplicated elements.
- Deterministic output for same input/comparator.
- Syntax check must pass before tests.
- Unit tests must pass before benchmark.

For algorithmic changes, add or update tests first (or in the same iteration) to cover changed invariants.

## Orchestrator Model (Local Beam DFS)

Definitions:
- Anchor = last accepted winner on active path.
- Variant = one child family started from an anchor, including its speculative losers until winner or abandonment.
- Loser family = all losing attempts descended from the first losing child of an anchor/winner.

Rules:
- Winner/loser decision compares candidate against anchor score (not immediate parent score).
- Winners/root own real child slots. Only starting a fresh sibling variant from a winner/root consumes one of those slots.
- Loser-family continuations do not consume winner child slots; they consume the shared family loss budget.
- Keep a tiny local beam inside each loser family so a promising loser can receive siblings instead of always mutating the latest damaged loser.
- Promising loser: guardrails pass and close to anchor, or improves a niche, or is novel with limited regression.
- Dead loser: correctness fail, strong guardrail fail, broad regression, no useful niche/novelty signal, or exhausted loser child limit.
- Next parent: continue latest if it is still promising; otherwise branch from the best alive promising loser; otherwise allow one ugly continuation or strict fallback until the family budget is exhausted.
- If speculative loser budget is exhausted with no winner, backtrack to nearest prior winner with free child slots.

Numeric Local Beam defaults mirrored in code:
- close to anchor = overall regression no worse than `0.75%`
- niche improvement = at least one preset improves by `2.00%`
- catastrophic overall regression = `-1.00%` or worse
- catastrophic preset regression = `-2.00%` or worse

### Branch Limits (authoritative defaults mirrored in code)

- `MAX_ROOT_BRANCHES = 6`
- `MAX_CHILD_VARIANTS_PER_WINNER = 3`
- `MAX_SPECULATIVE_LOSSES = 5`
- `LOCAL_BEAM_WIDTH = 2`
- `MAX_CHILDREN_PER_LOSER = 2`
- `MAX_UGLY_CONTINUATIONS_PER_FAMILY = 1`

If these change, update both this file and `orchestrator_policy_core.js` together (consumed by orchestrator and simulator).

## Decision Metric Policy

Primary metric is normalized p50 score:
- Per case: `scoreP50 = candidate_p50 / native_p50`
- Per preset (`quick`, `medium`, `balanced`): geomean of case `scoreP50`
- Overall suite score: geomean of preset scores

Winner rule (`auto-record`):
- overall score improvement vs anchor >= `1.00%`
- guardrail: no preset regression worse than `0.50%`

Telemetry:
- Keep raw timings (`avg`, `p50`) and normalized scores in logs/metadata.
- Immediate-parent deltas are secondary telemetry only.

## Snapshot and File Layout

- Rollback snapshots are managed only by orchestrator and stored in:
  - `algorithms/<id>/snapshots/<base-stem>/<id>_XXXX.js`
- Evolution metadata/logs are stored in:
  - `algorithms/<id>/evolution/<base-stem>/...`
- `<base-stem>` = `--base-file` without `.js` (example: `<id>_base_0120.js` -> `<id>_base_0120`).
- Never create manual snapshot files outside orchestrator flow.

## Command Canon (Use Exact Commands)

- Orchestrated loop:
  1. `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js next`
  2. `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js prepare`
  3. edit the active working sorter file
  4. `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js auto-record --idea "<short idea>" --display-preset medium`

- State inspection (where we are right now):
  - `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js status`
  - `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js next`
  - `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js list --limit 10`

- Snapshot operations:
  - `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js checkout --id <snapshot-id>`
  - `node sorting_experiments_cli.js --sorting <id> --base-file <base>.js prepare`

- Unit tests only:
  - `node unit_tests_cli.js --sorting <id>`

- Independent benchmark (current working file):
  - `node benchmarks_cli.js --sorting <id> --base-file <base>.js --presets quick,medium,balanced --candidate-file <working>.js`

- Independent benchmark (specific snapshot):
  - `node benchmarks_cli.js --sorting <id> --base-file <base>.js --presets quick,medium,balanced --candidate-file algorithms/<id>/snapshots/<base-stem>/<id>_XXXX.js`

- Evolution graph rendering:
  - `node evolution_graph_cli.js --sorting <id> --base-file <base>.js`
  - `node evolution_graph_cli.js --sorting <id> --input algorithms/<id>/evolution/<base-stem>/<id>_iterations.json`

- Sorter compatibility smoke:
  - `node sorting_compat_cli.js --sorting <id> --runs 1`

- Multi-sorter smoke matrix:
  - `node sorting_matrix_smoke_cli.js --sortings <id1,id2,...> --runs 1`

Rules:
- Unit tests first, then benchmarks.
- Never run more than one benchmark process at the same time in any mode (including ad-hoc checks, comparisons, and evolution-related runs). Benchmark commands must run strictly serially.
- Prefer direct `node ...` commands (do not switch to `npm` wrappers unless explicitly requested).
- Decision suite remains fixed to `quick,medium,balanced`; display preset only affects summary lines.
- Benchmark rows are generated in memory from fixed preset seeds. Normal benchmark/evolution runs do not read `algorithms/<id>/tables/*.bin`.

## Safety and Non-Strategic Failures

- Pipeline is mandatory: syntax check -> unit tests -> benchmark (only if tests pass).
- Do not use --skip-tests or --skip-benchmark unless explicitly requested by the user.
- On Windows, if `node --check` fails with `EPERM` (process spawn denied), treat it as infrastructure noise and use the in-code import-based syntax fallback; only fail syntax gate if fallback also fails.
- Syntax failures and unit-test failures are non-strategic attempts:
  - do not persist snapshots
  - do not consume child slots
  - do not consume speculative loss budget

## Reporting

After each batch, report:
- best snapshot id
- best overall normalized score (and corresponding raw timing context)
- delta vs anchor and delta vs immediate parent (telemetry)
- current orchestrator next target

If blocked (missing file, invalid metadata, failed import, test crash), stop and report exact blocker.

# Independent one off standalone benchmark
Three-way one-off benchmark (outside evolution): node benchmark_search_cli.js --sorting <id> --base-file <base>.js --candidate algorithms/<id>/snapshots/<base-stem>/<id>_XXXX.js --presets quick,medium,balanced,large --out algorithms/<id>/evolution/<base-stem>/benchmark_search_results.txt (compare native vs <id>_original.js vs candidate across quick,medium,balanced,large; print to console and write report file).

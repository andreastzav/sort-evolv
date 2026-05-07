import {
  SORT_CASES,
  USE_WARMUP,
  buildSortDescriptors,
  findBenchmarkPresetById,
  runSingleSortPass,
} from "./benchmarks_core.js";
import { generateRows } from "./generation_core.js";
import { toPositiveInt } from "./numeric_utils_core.js";
import { geometricMeanPositive, summarizeSamples } from "./stats_core.js";

export const SHARED_BENCHMARK_FLOW_ID = "shared_preset_session_baseline_targets";
export const SHARED_BENCHMARK_AB_TESTING = false; // If true, run mirrored A/B and B/A measured passes.
export const SHARED_BENCHMARK_ORDER_MODE = "alternate"; // "alternate" or "random" sorter order per repetition.
export const SHARED_BENCHMARK_DIRECTIONS = Object.freeze(["desc", "asc"]); // Directions benchmarked per case.
export const SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION = 1; // Warmup repetitions per case/direction/sorter.
export const SHARED_BENCHMARK_STORE_RAW_RUN_VALUES = false; // Persist detailed per-pass telemetry (case/direction/order/timings); useful for debugging noise but significantly increases metadata size.
export const SHARED_BENCHMARK_VALIDATE_SORTED = true; // Validate sorted output during measured passes.

function resolveStoreRawRuns(configValue) {
  return typeof configValue === "boolean"
    ? configValue
    : SHARED_BENCHMARK_STORE_RAW_RUN_VALUES;
}

function rotateArray(values, amount) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const shift = ((amount % values.length) + values.length) % values.length;
  if (shift === 0) {
    return values.slice();
  }

  return values.slice(shift).concat(values.slice(0, shift));
}

function shuffleWithSeed(values, seed) {
  const out = values.slice();
  let state = (Number(seed) >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }

  return out;
}

function buildMeasuredSorterOrder(sorters, context, orderMode) {
  const input = Array.isArray(sorters) ? sorters : [];
  if (input.length === 0) {
    return [];
  }

  if (orderMode === "random") {
    const seed =
      Number(context?.seed || 0) +
      Number(context?.caseIndex || 0) * 1009 +
      Number(context?.directionIndex || 0) * 9176 +
      Number(context?.runIndex || 0) * 8191 +
      Number(context?.abPassIndex || 0) * 131;
    return shuffleWithSeed(input, seed);
  }

  const rotation =
    Number(context?.caseIndex || 0) +
    Number(context?.directionIndex || 0) +
    Number(context?.runIndex || 0) +
    Number(context?.abPassIndex || 0);
  return rotateArray(input, rotation);
}

function createEmptyCaseSampleMap(cases) {
  const byCaseId = Object.create(null);
  for (let i = 0; i < cases.length; i += 1) {
    byCaseId[cases[i].id] = [];
  }

  return byCaseId;
}

function buildCaseSummariesFromSamples(cases, caseSamplesByCaseId) {
  const summaries = new Array(cases.length);
  for (let i = 0; i < cases.length; i += 1) {
    const benchCase = cases[i];
    summaries[i] = {
      id: benchCase.id,
      label: benchCase.label,
      keys: Array.isArray(benchCase.keys) ? benchCase.keys.slice() : [],
      ...summarizeSamples(caseSamplesByCaseId[benchCase.id]),
    };
  }

  return summaries;
}

function buildSorterSummary(sorter, sorterSamples, caseSamplesByCaseId, cases) {
  return {
    id: sorter.id,
    label: sorter.label,
    cases: buildCaseSummariesFromSamples(cases, caseSamplesByCaseId),
    ...summarizeSamples(sorterSamples),
  };
}

export function createSorter(id, label, sortFn) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("Sorter id must be a non-empty string.");
  }
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("Sorter label must be a non-empty string.");
  }
  if (typeof sortFn !== "function") {
    throw new Error("sortFn must be a function.");
  }

  return Object.freeze({
    id: id.trim(),
    label: label.trim(),
    sortInPlace(array, compareFn) {
      return sortFn(array, compareFn);
    },
  });
}

export function runSharedPresetBenchmarkSession(config = {}) {
  const rows = config.rows;
  if (!Array.isArray(rows)) {
    throw new TypeError("runSharedPresetBenchmarkSession expects rows array.");
  }

  const sorters = Array.isArray(config.sorters) ? config.sorters : [];
  if (sorters.length === 0) {
    throw new Error("runSharedPresetBenchmarkSession requires at least one sorter.");
  }

  const cases = Array.isArray(config.cases) && config.cases.length > 0 ? config.cases : SORT_CASES;
  const directions =
    Array.isArray(config.directions) && config.directions.length > 0
      ? config.directions.map((item) => (item === "desc" ? "desc" : "asc"))
      : SHARED_BENCHMARK_DIRECTIONS.slice();
  const runsPerCase = toPositiveInt(config.runsPerCase, 1);
  const orderMode =
    config.orderMode === "random" || config.orderMode === "alternate"
      ? config.orderMode
      : SHARED_BENCHMARK_ORDER_MODE;
  const abTesting = config.abTesting === true ? true : SHARED_BENCHMARK_AB_TESTING;
  const useWarmup = typeof config.useWarmup === "boolean" ? config.useWarmup : USE_WARMUP;
  const warmupRunsPerCombination = useWarmup
    ? toPositiveInt(config.warmupRunsPerCombination, SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION)
    : 0;
  const storeRawRuns = resolveStoreRawRuns(config.storeRawRuns);
  const validateSorted =
    typeof config.validateSorted === "boolean"
      ? config.validateSorted
      : SHARED_BENCHMARK_VALIDATE_SORTED;

  const rawRuns = [];
  const sorterSamplesById = Object.create(null);
  const caseSamplesBySorterId = Object.create(null);
  let warmupTotalMs = 0;
  let measuredTotalMs = 0;

  for (let i = 0; i < sorters.length; i += 1) {
    const sorter = sorters[i];
    sorterSamplesById[sorter.id] = [];
    caseSamplesBySorterId[sorter.id] = createEmptyCaseSampleMap(cases);
  }

  if (useWarmup) {
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const benchCase = cases[caseIndex];
      for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
        const direction = directions[directionIndex];
        const descriptors = buildSortDescriptors(benchCase.keys, direction);
        for (let warmupRun = 0; warmupRun < warmupRunsPerCombination; warmupRun += 1) {
          for (let sorterIndex = 0; sorterIndex < sorters.length; sorterIndex += 1) {
            const sorter = sorters[sorterIndex];
            const passResult = runSingleSortPass(rows, descriptors, sorter, {
              validateSorted: false,
            });
            warmupTotalMs += Number(passResult.totalMs);
          }
        }
      }
    }
  }

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const benchCase = cases[caseIndex];
    for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
      const direction = directions[directionIndex];
      const descriptors = buildSortDescriptors(benchCase.keys, direction);
      for (let runIndex = 0; runIndex < runsPerCase; runIndex += 1) {
        const passCount = abTesting ? 2 : 1;
        for (let abPassIndex = 0; abPassIndex < passCount; abPassIndex += 1) {
          const baseOrder = buildMeasuredSorterOrder(
            sorters,
            {
              seed: config.seed,
              caseIndex,
              directionIndex,
              runIndex,
              abPassIndex,
            },
            orderMode
          );
          const runOrder = abPassIndex === 0 ? baseOrder : baseOrder.slice().reverse();
          const runRecord = {
            case_id: benchCase.id,
            direction,
            run_index: runIndex + 1,
            pass_index: abPassIndex + 1,
            order: runOrder.map((item) => item.id),
          };

          for (let sorterIndex = 0; sorterIndex < runOrder.length; sorterIndex += 1) {
            const sorter = runOrder[sorterIndex];
            const passResult = runSingleSortPass(rows, descriptors, sorter, {
              validateSorted,
            });
            const durationMs = Number(passResult.totalMs);
            sorterSamplesById[sorter.id].push(durationMs);
            caseSamplesBySorterId[sorter.id][benchCase.id].push(durationMs);
            measuredTotalMs += durationMs;
            runRecord[`${sorter.id}_ms`] = durationMs;
          }

          if (storeRawRuns) {
            rawRuns.push(runRecord);
          }
        }
      }
    }
  }

  const sorterSummaries = new Array(sorters.length);
  const sorterSummariesById = Object.create(null);
  for (let i = 0; i < sorters.length; i += 1) {
    const sorter = sorters[i];
    const summary = buildSorterSummary(
      sorter,
      sorterSamplesById[sorter.id],
      caseSamplesBySorterId[sorter.id],
      cases
    );
    sorterSummaries[i] = summary;
    sorterSummariesById[sorter.id] = summary;
  }

  return {
    rowCount: rows.length,
    runsPerCase,
    directions: directions.slice(),
    caseCount: cases.length,
    measuredTotalMs,
    warmupTotalMs,
    sorterSummaries,
    sorterSummariesById,
    rawRuns: storeRawRuns ? rawRuns : null,
    orderMode,
    abTestingEnabled: abTesting,
    warmupEnabled: useWarmup,
    warmupRunsPerCombination,
  };
}

export function buildComparisonSummary(baselineCases, targetCases, targetId) {
  if (!Array.isArray(baselineCases) || !Array.isArray(targetCases)) {
    return null;
  }

  const targetById = Object.create(null);
  for (let i = 0; i < targetCases.length; i += 1) {
    targetById[targetCases[i].id] = targetCases[i];
  }

  const scores = [];
  for (let i = 0; i < baselineCases.length; i += 1) {
    const baselineCase = baselineCases[i];
    const targetCase = targetById[baselineCase.id];
    const baselineP50Ms = Number(baselineCase?.p50Ms);
    const targetP50Ms = Number(targetCase?.p50Ms);
    if (
      Number.isFinite(baselineP50Ms) &&
      baselineP50Ms > 0 &&
      Number.isFinite(targetP50Ms) &&
      targetP50Ms >= 0
    ) {
      scores.push(targetP50Ms / baselineP50Ms);
    }
  }

  const geomeanScoreP50 = geometricMeanPositive(scores);
  const geomeanImprovementP50Pct = Number.isFinite(geomeanScoreP50)
    ? (1 - geomeanScoreP50) * 100
    : Number.NaN;

  return {
    baselineSorterId: "baseline",
    compareSorterId: targetId,
    metric: "p50Ms",
    geomeanScoreP50,
    geomeanImprovementP50Pct,
    caseCount: baselineCases.length,
  };
}

export function buildTotalsFromSharedSession(rowCount, runsPerCase, baselineSummary, targetSummary, targetId) {
  const nativeAvgMs = Number(baselineSummary?.avgMs);
  const candidateAvgMs = Number(targetSummary?.avgMs);
  const improvementVsNativePct =
    Number.isFinite(nativeAvgMs) && nativeAvgMs > 0 && Number.isFinite(candidateAvgMs)
      ? ((nativeAvgMs - candidateAvgMs) / nativeAvgMs) * 100
      : Number.NaN;
  const comparison = buildComparisonSummary(baselineSummary?.cases, targetSummary?.cases, targetId);

  const baseline = {
    avgMs: Number(baselineSummary?.avgMs),
    p50Ms: Number(baselineSummary?.p50Ms),
    p75Ms: Number(baselineSummary?.p75Ms),
    p95Ms: Number(baselineSummary?.p95Ms),
    sampleCount: Number(baselineSummary?.sampleCount),
  };
  const candidate = {
    avgMs: Number(targetSummary?.avgMs),
    p50Ms: Number(targetSummary?.p50Ms),
    p75Ms: Number(targetSummary?.p75Ms),
    p95Ms: Number(targetSummary?.p95Ms),
    sampleCount: Number(targetSummary?.sampleCount),
  };

  return {
    rowCount,
    runsPerCase,
    totalBenchmarkMs: Number(targetSummary?.totalMs),
    baseline,
    candidate,
    improvementVsNativePct,
    comparison: comparison
      ? {
          metric: comparison.metric,
          geomeanScoreP50: comparison.geomeanScoreP50,
          geomeanImprovementP50Pct: comparison.geomeanImprovementP50Pct,
          caseCount: comparison.caseCount,
        }
      : null,
  };
}

export function runSharedPresetSuite(config = {}) {
  const sorters = Array.isArray(config.sorters) ? config.sorters : [];
  if (sorters.length < 2) {
    throw new Error("runSharedPresetSuite requires baseline sorter and at least one target sorter.");
  }

  const presetIds = Array.isArray(config.presetIds) && config.presetIds.length > 0
    ? config.presetIds.slice()
    : [];
  if (presetIds.length === 0) {
    throw new Error("runSharedPresetSuite requires at least one preset id.");
  }

  const baselineSorterId = typeof config.baselineSorterId === "string" && config.baselineSorterId.trim() !== ""
    ? config.baselineSorterId.trim()
    : sorters[0].id;
  const targetSorterIds = Array.isArray(config.targetSorterIds) && config.targetSorterIds.length > 0
    ? config.targetSorterIds.slice()
    : sorters.filter((sorter) => sorter.id !== baselineSorterId).map((sorter) => sorter.id);
  if (targetSorterIds.length === 0) {
    throw new Error("runSharedPresetSuite requires at least one target sorter id.");
  }

  const sorterById = new Map(sorters.map((sorter) => [sorter.id, sorter]));
  if (!sorterById.has(baselineSorterId)) {
    throw new Error(`Baseline sorter missing from sorter list: ${baselineSorterId}`);
  }
  for (let i = 0; i < targetSorterIds.length; i += 1) {
    if (!sorterById.has(targetSorterIds[i])) {
      throw new Error(`Target sorter missing from sorter list: ${targetSorterIds[i]}`);
    }
  }

  const totalsByTargetId = Object.create(null);
  const suiteBenchmarkTotalMsByTargetId = Object.create(null);
  for (let i = 0; i < targetSorterIds.length; i += 1) {
    const targetId = targetSorterIds[i];
    totalsByTargetId[targetId] = Object.create(null);
    suiteBenchmarkTotalMsByTargetId[targetId] = 0;
  }

  const storeRawRuns = resolveStoreRawRuns(config.storeRawRuns);
  const rawRunsByPreset = storeRawRuns ? Object.create(null) : null;
  const sessionMeasuredTotalByPreset = Object.create(null);
  const sessionWarmupTotalByPreset = Object.create(null);
  const onPresetComplete = typeof config.onPresetComplete === "function" ? config.onPresetComplete : null;
  let suiteMeasuredTotalMs = 0;
  let suiteWarmupTotalMs = 0;

  for (let i = 0; i < presetIds.length; i += 1) {
    const presetId = presetIds[i];
    const preset = findBenchmarkPresetById(presetId);
    if (!preset) {
      throw new Error(`Unknown benchmark preset: ${presetId}`);
    }

    const rows = generateRows(preset.rowCount, {
      seed: preset.seed,
    });
    const runsPerCase =
      config.benchmarkRunsOverride !== null && config.benchmarkRunsOverride !== undefined
        ? toPositiveInt(config.benchmarkRunsOverride, preset.runs)
        : preset.runs;
    const session = runSharedPresetBenchmarkSession({
      rows,
      runsPerCase,
      sorters,
      seed: Number(preset.seed),
      cases: config.cases,
      directions: config.directions,
      orderMode: config.orderMode,
      abTesting: config.abTesting,
      useWarmup: config.useWarmup,
      warmupRunsPerCombination: config.warmupRunsPerCombination,
      storeRawRuns,
      validateSorted: config.validateSorted,
    });

    const baselineSummary = session.sorterSummariesById[baselineSorterId];
    if (!baselineSummary) {
      throw new Error(`Baseline summary missing for preset ${presetId}: ${baselineSorterId}`);
    }

    for (let j = 0; j < targetSorterIds.length; j += 1) {
      const targetId = targetSorterIds[j];
      const targetSummary = session.sorterSummariesById[targetId];
      if (!targetSummary) {
        throw new Error(`Target summary missing for preset ${presetId}: ${targetId}`);
      }
      const totals = buildTotalsFromSharedSession(
        session.rowCount,
        session.runsPerCase,
        baselineSummary,
        targetSummary,
        targetId
      );
      totalsByTargetId[targetId][presetId] = totals;
      suiteBenchmarkTotalMsByTargetId[targetId] += Number(totals.totalBenchmarkMs);
    }

    sessionMeasuredTotalByPreset[presetId] = Number(session.measuredTotalMs);
    sessionWarmupTotalByPreset[presetId] = Number(session.warmupTotalMs);
    if (storeRawRuns && rawRunsByPreset && Array.isArray(session.rawRuns)) {
      rawRunsByPreset[presetId] = session.rawRuns;
    }
    if (onPresetComplete) {
      onPresetComplete({
        presetId,
        rowCount: session.rowCount,
        runsPerCase: session.runsPerCase,
        measuredTotalMs: Number(session.measuredTotalMs),
        warmupTotalMs: Number(session.warmupTotalMs),
      });
    }
    suiteMeasuredTotalMs += Number(session.measuredTotalMs);
    suiteWarmupTotalMs += Number(session.warmupTotalMs);
  }

  return {
    presetIds,
    baselineSorterId,
    targetSorterIds: targetSorterIds.slice(),
    totalsByTargetId,
    rawRunsByPreset,
    sessionMeasuredTotalByPreset,
    sessionWarmupTotalByPreset,
    suiteMeasuredTotalMs,
    suiteWarmupTotalMs,
    suiteBenchmarkTotalMsByTargetId,
    combinedSuiteBenchmarkTotalMs: suiteMeasuredTotalMs,
    benchmarkFlow: SHARED_BENCHMARK_FLOW_ID,
    abTestingEnabled:
      typeof config.abTesting === "boolean" ? config.abTesting : SHARED_BENCHMARK_AB_TESTING,
    orderMode:
      config.orderMode === "random" || config.orderMode === "alternate"
        ? config.orderMode
        : SHARED_BENCHMARK_ORDER_MODE,
    warmupEnabled: typeof config.useWarmup === "boolean" ? config.useWarmup : USE_WARMUP,
    warmupRunsPerCombination:
      typeof config.useWarmup === "boolean" && config.useWarmup === false
        ? 0
        : toPositiveInt(
            config.warmupRunsPerCombination,
            SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION
          ),
  };
}

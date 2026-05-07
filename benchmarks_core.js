import {
  COLUMN_TYPE_BY_KEY,
  formatCount
} from "./generation_core.js";
import { NATIVE_SORTER } from "./native-sort.js";
import { toPositiveInt } from "./numeric_utils_core.js";
import {
  BENCHMARK_PRESETS as CANONICAL_BENCHMARK_PRESETS,
  DEFAULT_BENCHMARK_PRESET_IDS as CANONICAL_DEFAULT_BENCHMARK_PRESET_IDS,
} from "./preset_catalog_core.js";
import { geometricMeanPositive, summarizeSamples } from "./stats_core.js";

const DEFAULT_RUNS_PER_CASE = 3; // Measured runs per sorter/case/direction when not overridden.
const DEFAULT_DIRECTIONS = Object.freeze(["desc", "asc"]); // Benchmark both directions for each case.
const DEFAULT_WARMUP_RUNS_PER_COMBINATION = 1; // Warmup passes per sorter/case/direction when warmup is on.
export const USE_WARMUP = true; // Global warmup toggle used by browser and CLI benchmarks.

function requireBenchmarkProfile(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("Benchmark profile is required. Pass options.profile.");
  }

  const candidateSorterId = String(profile.candidateSorterId || "").trim();
  if (candidateSorterId === "") {
    throw new Error("Benchmark profile must define candidateSorterId.");
  }

  const candidateLabel = String(profile.candidateLabel || "").trim() || candidateSorterId;
  return {
    ...profile,
    candidateSorterId,
    candidateLabel,
  };
}

export function defaultSorterIdsForProfile(profile) {
  const resolvedProfile = requireBenchmarkProfile(profile);
  return ["native", resolvedProfile.candidateSorterId];
}

export const BENCHMARK_PRESETS = CANONICAL_BENCHMARK_PRESETS;

export const DEFAULT_BENCHMARK_PRESET_IDS = CANONICAL_DEFAULT_BENCHMARK_PRESET_IDS;

export const SORT_CASES = Object.freeze([
  { id: "index", label: "Index", keys: ["index"] },
  { id: "age", label: "Age", keys: ["age"] },
  { id: "city", label: "City", keys: ["city"] },
  { id: "date", label: "Date", keys: ["date"] },
  { id: "segment", label: "Segment", keys: ["segment"] },
  { id: "cohort", label: "Cohort", keys: ["cohort"] },
  { id: "random-a", label: "Random A", keys: ["randomA"] },
  { id: "random-b", label: "Random B", keys: ["randomB"] },
  {
    id: "first-last",
    label: "First Name + Last Name",
    keys: ["firstName", "lastName"]
  },
  {
    id: "last-first",
    label: "Last Name + First Name",
    keys: ["lastName", "firstName"]
  },
  { id: "age-city", label: "Age + City", keys: ["age", "city"] },
  { id: "random-a-b", label: "Random A + Random B", keys: ["randomA", "randomB"] },
  { id: "random-b-date", label: "Random B + Date", keys: ["randomB", "date"] },
  {
    id: "lastname-random-a-random-b",
    label: "Last Name + Random A + Random B",
    keys: ["lastName", "randomA", "randomB"]
  },
  {
    id: "first-last-random-a",
    label: "First Name + Last Name + Random A",
    keys: ["firstName", "lastName", "randomA"]
  }
]);

function nowMs() {
  if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function asFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.NaN;
}

function compareNumbers(a, b) {
  if (a === b) {
    return 0;
  }

  const left = asFiniteNumber(a);
  const right = asFiniteNumber(b);

  if (Number.isNaN(left) && Number.isNaN(right)) {
    return 0;
  }

  if (Number.isNaN(left)) {
    return 1;
  }

  if (Number.isNaN(right)) {
    return -1;
  }

  return left - right;
}

function compareStrings(a, b) {
  if (a === b) {
    return 0;
  }

  if (a === undefined || a === null) {
    return 1;
  }

  if (b === undefined || b === null) {
    return -1;
  }

  const left = String(a);
  const right = String(b);
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function compareByType(type, a, b) {
  if (type === "number") {
    return compareNumbers(a, b);
  }

  if (type === "date") {
    return compareStrings(a, b);
  }

  return compareStrings(a, b);
}

export function buildSortDescriptors(keys, direction = "asc") {
  const normalizedDirection = direction === "desc" ? "desc" : "asc";
  const descriptors = new Array(keys.length);
  for (let i = 0; i < keys.length; i += 1) {
    descriptors[i] = {
      key: keys[i],
      direction: normalizedDirection
    };
  }

  return descriptors;
}

export function createRowComparator(descriptors, columnTypeByKey = COLUMN_TYPE_BY_KEY) {
  const descriptorList = Array.isArray(descriptors) ? descriptors : [];

  return function comparator(leftRow, rightRow) {
    for (let i = 0; i < descriptorList.length; i += 1) {
      const descriptor = descriptorList[i];
      const key = descriptor.key;
      const directionMultiplier = descriptor.direction === "desc" ? -1 : 1;
      const valueType = columnTypeByKey[key] || "string";
      const compareResult =
        compareByType(valueType, leftRow ? leftRow[key] : undefined, rightRow ? rightRow[key] : undefined) *
        directionMultiplier;

      if (compareResult !== 0) {
        return compareResult;
      }
    }

    return 0;
  };
}

function buildP50Comparison(sorterSummaries, profile) {
  if (!Array.isArray(sorterSummaries) || sorterSummaries.length === 0) {
    return null;
  }

  const resolvedProfile = requireBenchmarkProfile(profile);
  let baselineSorter = null;
  let candidateSorter = null;
  for (let i = 0; i < sorterSummaries.length; i += 1) {
    const sorterSummary = sorterSummaries[i];
    if (sorterSummary && sorterSummary.id === NATIVE_SORTER.id) {
      baselineSorter = sorterSummary;
      continue;
    }
    if (
      sorterSummary &&
      sorterSummary.id === resolvedProfile.candidateSorterId
    ) {
      candidateSorter = sorterSummary;
    }
  }

  if (!candidateSorter) {
    for (let i = 0; i < sorterSummaries.length; i += 1) {
      const sorterSummary = sorterSummaries[i];
      if (sorterSummary && sorterSummary.id !== NATIVE_SORTER.id) {
        candidateSorter = sorterSummary;
        break;
      }
    }
  }

  if (!baselineSorter || !candidateSorter) {
    return null;
  }

  const candidateCaseById = Object.create(null);
  for (let i = 0; i < candidateSorter.cases.length; i += 1) {
    const candidateCase = candidateSorter.cases[i];
    candidateCaseById[candidateCase.id] = candidateCase;
  }

  const caseComparisons = [];
  const scores = [];
  for (let i = 0; i < baselineSorter.cases.length; i += 1) {
    const baselineCase = baselineSorter.cases[i];
    const candidateCase = candidateCaseById[baselineCase.id];
    const baselineP50Ms = Number(baselineCase.p50Ms);
    const candidateP50Ms = candidateCase ? Number(candidateCase.p50Ms) : Number.NaN;
    const canScore =
      Number.isFinite(baselineP50Ms) &&
      baselineP50Ms > 0 &&
      Number.isFinite(candidateP50Ms) &&
      candidateP50Ms >= 0;
    const scoreP50 = canScore ? candidateP50Ms / baselineP50Ms : Number.NaN;
    const improvementP50Pct = Number.isFinite(scoreP50) ? (1 - scoreP50) * 100 : Number.NaN;

    caseComparisons.push({
      id: baselineCase.id,
      label: baselineCase.label,
      baselineP50Ms,
      candidateP50Ms,
      scoreP50,
      improvementP50Pct
    });

    if (Number.isFinite(scoreP50) && scoreP50 > 0) {
      scores.push(scoreP50);
    }
  }

  if (caseComparisons.length === 0) {
    return null;
  }

  const geomeanScoreP50 = geometricMeanPositive(scores);
  const geomeanImprovementP50Pct = Number.isFinite(geomeanScoreP50)
    ? (1 - geomeanScoreP50) * 100
    : Number.NaN;

  return {
    baselineSorterId: baselineSorter.id,
    compareSorterId: candidateSorter.id,
    compareLabel: candidateSorter.label,
    metric: "p50Ms",
    cases: caseComparisons,
    geomeanScoreP50,
    geomeanImprovementP50Pct
  };
}

function resolveSorter(entry, context) {
  if (!entry) {
    return null;
  }

  const candidateSorterId = String(context.profile.candidateSorterId || "").trim();
  if (typeof entry === "string") {
    const token = entry.trim();
    if (token === "native") {
      return NATIVE_SORTER;
    }
    if (token === candidateSorterId) {
      return context.candidateSorter;
    }
    return null;
  }

  if (
    typeof entry === "object" &&
    typeof entry.id === "string" &&
    typeof entry.label === "string" &&
    typeof entry.sortInPlace === "function"
  ) {
    return entry;
  }

  return null;
}

function resolveSorters(sorters, context) {
  const requested =
    Array.isArray(sorters) && sorters.length > 0
      ? sorters
      : defaultSorterIdsForProfile(context.profile);
  const resolved = [];
  const candidateSorterId = String(context.profile.candidateSorterId || "").trim();

  for (let i = 0; i < requested.length; i += 1) {
    const rawEntry = requested[i];
    const sorter = resolveSorter(rawEntry, context);
    if (sorter) {
      resolved.push(sorter);
      continue;
    }

    const token = typeof rawEntry === "string" ? rawEntry.trim() : "";
    if (token === candidateSorterId) {
      const reason = String(context.candidateSorterError || "").trim();
      throw new Error(
        `Candidate sorter "${candidateSorterId}" is unavailable.${
          reason ? ` ${reason}` : ""
        }`
      );
    }

    if (typeof rawEntry === "string" && token !== "") {
      throw new Error(
        `Unknown sorter id "${token}". Supported ids: native, ${candidateSorterId}.`
      );
    }

    throw new Error(
      "Invalid sorter entry. Expected sorter id string or sorter object {id,label,sortInPlace}."
    );
  }

  if (resolved.length === 0) {
    throw new Error("No valid sorters were provided.");
  }

  return resolved;
}

function resolveWarmupConfig(options = {}) {
  const explicit = options.useWarmup;
  const enabled = typeof explicit === "boolean" ? explicit : USE_WARMUP;
  const runsPerCombination = enabled
    ? toPositiveInt(options.warmupRuns, DEFAULT_WARMUP_RUNS_PER_COMBINATION)
    : 0;

  return {
    enabled,
    runsPerCombination
  };
}

function createWarmupSummaryDisabled() {
  return {
    enabled: false,
    runsPerCombination: 0,
    totalPasses: 0,
    totalMs: 0,
    bySorter: []
  };
}

function runWarmupPhase(rows, benchCases, directions, sorters, runsPerCombination, options = {}) {
  const validateSorted = options.validateSorted === true;
  const bySorter = new Array(sorters.length);
  let totalPasses = 0;
  const warmupStartMs = nowMs();

  for (let sorterIndex = 0; sorterIndex < sorters.length; sorterIndex += 1) {
    const sorter = sorters[sorterIndex];
    const sorterStartMs = nowMs();
    let sorterPasses = 0;

    for (let caseIndex = 0; caseIndex < benchCases.length; caseIndex += 1) {
      const benchCase = benchCases[caseIndex];
      for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
        const direction = directions[directionIndex];
        const descriptors = buildSortDescriptors(benchCase.keys, direction);

        for (let warmupRun = 0; warmupRun < runsPerCombination; warmupRun += 1) {
          runSingleSortPass(rows, descriptors, sorter, {
            validateSorted
          });
          sorterPasses += 1;
          totalPasses += 1;
        }
      }
    }

    bySorter[sorterIndex] = {
      id: sorter.id,
      label: sorter.label,
      totalPasses: sorterPasses,
      totalMs: nowMs() - sorterStartMs
    };
  }

  return {
    enabled: true,
    runsPerCombination,
    totalPasses,
    totalMs: nowMs() - warmupStartMs,
    bySorter
  };
}

function assertSorted(rows, comparator) {
  for (let i = 1; i < rows.length; i += 1) {
    if (comparator(rows[i - 1], rows[i]) > 0) {
      throw new Error(`Result validation failed at index ${i - 1} for sorted output.`);
    }
  }
}

export function runSingleSortPass(rows, descriptors, sorter, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError("runSingleSortPass expects an array of rows.");
  }

  const workingRows = rows.slice();
  const comparator = createRowComparator(descriptors, options.columnTypeByKey || COLUMN_TYPE_BY_KEY);
  const startMs = nowMs();
  sorter.sortInPlace(workingRows, comparator);
  const sortMs = nowMs() - startMs;

  if (options.validateSorted === true) {
    assertSorted(workingRows, comparator);
  }

  return {
    rows: workingRows,
    sortMs,
    totalMs: sortMs
  };
}

export function runSortBenchmark(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError("runSortBenchmark expects an array of rows.");
  }

  const profile = requireBenchmarkProfile(options.profile);
  const runsPerCase = toPositiveInt(options.runs, DEFAULT_RUNS_PER_CASE);
  const directions =
    Array.isArray(options.directions) && options.directions.length > 0
      ? options.directions.map((value) => (value === "desc" ? "desc" : "asc"))
      : DEFAULT_DIRECTIONS.slice();
  const benchCases = Array.isArray(options.cases) && options.cases.length > 0 ? options.cases : SORT_CASES;
  const sorters = resolveSorters(options.sorters, {
    profile,
    candidateSorter: options.candidateSorter || null,
    candidateSorterError: options.candidateSorterError || "",
  });
  const warmupConfig = resolveWarmupConfig(options);
  const warmup = warmupConfig.enabled
    ? runWarmupPhase(rows, benchCases, directions, sorters, warmupConfig.runsPerCombination, {
        validateSorted: false
      })
    : createWarmupSummaryDisabled();
  const benchmarkStartMs = nowMs();
  const sorterSummaries = [];

  for (let sorterIndex = 0; sorterIndex < sorters.length; sorterIndex += 1) {
    const sorter = sorters[sorterIndex];
    const sorterSamples = [];
    const caseSummaries = [];

    for (let caseIndex = 0; caseIndex < benchCases.length; caseIndex += 1) {
      const benchCase = benchCases[caseIndex];
      const caseSamples = [];

      for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
        const direction = directions[directionIndex];
        const descriptors = buildSortDescriptors(benchCase.keys, direction);

        for (let runIndex = 0; runIndex < runsPerCase; runIndex += 1) {
          const passResult = runSingleSortPass(rows, descriptors, sorter, {
            validateSorted: options.validateSorted === true
          });
          caseSamples.push(passResult.totalMs);
          sorterSamples.push(passResult.totalMs);
        }
      }

      caseSummaries.push({
        id: benchCase.id,
        label: benchCase.label,
        keys: benchCase.keys.slice(),
        ...summarizeSamples(caseSamples)
      });
    }

    sorterSummaries.push({
      id: sorter.id,
      label: sorter.label,
      cases: caseSummaries,
      ...summarizeSamples(sorterSamples)
    });
  }

  const totalBenchmarkMs = nowMs() - benchmarkStartMs;
  const comparison = buildP50Comparison(sorterSummaries, profile);

  return {
    rowCount: rows.length,
    runsPerCase,
    directions,
    sorterCount: sorters.length,
    caseCount: benchCases.length,
    totalBenchmarkMs,
    warmup,
    sorterSummaries,
    comparison,
    generatedAtIso: new Date().toISOString()
  };
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  });
}

function formatSecondsFromMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }

  return (numeric / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}

function formatBenchmarkCaseSummaryLine(caseSummary) {
  return `${caseSummary.label} avg: ${formatMs(caseSummary.avgMs)} ms, p50: ${formatMs(
    caseSummary.p50Ms
  )} ms, p75: ${formatMs(caseSummary.p75Ms)} ms, p95: ${formatMs(caseSummary.p95Ms)} ms (${caseSummary.sampleCount} runs)`;
}

function formatBenchmarkSorterSummaryLine(sorterSummary) {
  return `Total avg (all cases): ${formatMs(sorterSummary.avgMs)} ms, p50: ${formatMs(
    sorterSummary.p50Ms
  )} ms, p75: ${formatMs(sorterSummary.p75Ms)} ms, p95: ${formatMs(sorterSummary.p95Ms)} ms (${sorterSummary.sampleCount} runs)`;
}

function formatBenchmarkFinalSorterLine(sorterSummary) {
  return `${sorterSummary.label} -> avg: ${formatMs(sorterSummary.avgMs)} ms, p50: ${formatMs(
    sorterSummary.p50Ms
  )} ms, p75: ${formatMs(sorterSummary.p75Ms)} ms, p95: ${formatMs(sorterSummary.p95Ms)} ms (${sorterSummary.sampleCount} runs)`;
}

function formatScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
    useGrouping: false
  });
}

function formatSignedPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  const sign = numeric >= 0 ? "+" : "-";
  const absValue = Math.abs(numeric);
  return `${sign}${absValue.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false
  })}%`;
}

function formatMsOrNa(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  return formatMs(numeric);
}

export function formatBenchmarkReportLines(report, options = {}) {
  const lines = [];
  lines.push(`Sort benchmark started on ${formatCount(report.rowCount)} rows.`);

  if (options.datasetLabel) {
    lines.push(`Dataset: ${options.datasetLabel}.`);
  }

  lines.push(
    `Runs: ${report.runsPerCase} per sort case per direction (${report.directions.join(" + ")}).`
  );
  if (report.warmup && report.warmup.enabled) {
    lines.push(
      `Warmup: enabled (${report.warmup.runsPerCombination} per sorter/case/direction), ${report.warmup.totalPasses} passes, ${formatMs(
        report.warmup.totalMs
      )} ms (${formatSecondsFromMs(report.warmup.totalMs)} s).`
    );
    lines.push("Reported timings: total ms (excluding warmup).");
  } else {
    lines.push("Reported timings: total ms (no warmup).");
  }

  for (let sorterIndex = 0; sorterIndex < report.sorterSummaries.length; sorterIndex += 1) {
    const sorterSummary = report.sorterSummaries[sorterIndex];
    lines.push("");
    lines.push(`[${sorterIndex + 1}/${report.sorterSummaries.length}] ${sorterSummary.label}`);

    for (let caseIndex = 0; caseIndex < sorterSummary.cases.length; caseIndex += 1) {
      const caseSummary = sorterSummary.cases[caseIndex];
      lines.push(formatBenchmarkCaseSummaryLine(caseSummary));
    }

    lines.push(formatBenchmarkSorterSummaryLine(sorterSummary));
  }

  lines.push("");
  lines.push("Final totals per sorter:");
  for (let i = 0; i < report.sorterSummaries.length; i += 1) {
    const item = report.sorterSummaries[i];
    lines.push(formatBenchmarkFinalSorterLine(item));
  }

  if (report.comparison && Array.isArray(report.comparison.cases) && report.comparison.cases.length > 0) {
    const compareLabel = String(
      report.comparison.compareLabel ||
        report.comparison.compareSorterId ||
        options.candidateLabel ||
        "candidate"
    );
    lines.push("");
    lines.push("Comparison vs native (p50-based):");
    for (let i = 0; i < report.comparison.cases.length; i += 1) {
      const caseComparison = report.comparison.cases[i];
      lines.push(
        `- ${caseComparison.label}: native p50 ${formatMsOrNa(caseComparison.baselineP50Ms)} ms, ${compareLabel} p50 ${formatMsOrNa(
          caseComparison.candidateP50Ms
        )} ms, score ${formatScore(caseComparison.scoreP50)}, improvement ${formatSignedPct(
          caseComparison.improvementP50Pct
        )}`
      );
    }
    lines.push("Overall:");
    lines.push(`- geomean score: ${formatScore(report.comparison.geomeanScoreP50)}`);
    lines.push(
      `- geomean improvement: ${formatSignedPct(report.comparison.geomeanImprovementP50Pct)}`
    );
  }

  lines.push(`Sort benchmark finished in ${formatSecondsFromMs(report.totalBenchmarkMs)} s.`);
  return lines;
}

export function findBenchmarkPresetById(presetId) {
  for (let i = 0; i < BENCHMARK_PRESETS.length; i += 1) {
    if (BENCHMARK_PRESETS[i].id === presetId) {
      return BENCHMARK_PRESETS[i];
    }
  }

  return null;
}



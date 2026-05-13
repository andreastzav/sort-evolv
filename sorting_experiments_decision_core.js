import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { USE_WARMUP, findBenchmarkPresetById, runSortBenchmark } from "./benchmarks_core.js";
import { generateRows } from "./generation_core.js";
import { NATIVE_SORTER } from "./native-sort.js";
import {
  createSorter as createSharedSorter,
  runSharedPresetSuite,
} from "./shared_benchmark_session_core.js";
import { toPositiveInt } from "./cli_arg_utils_core.js";
import { geometricMeanPositive } from "./stats_core.js";

export function parseRecordArgs(argv, options = {}) {
  const defaultBenchmarkPreset = options.defaultBenchmarkPreset || "medium";
  const args = {
    idea: "",
    status: "",
    parentId: null,
    newBranch: false,
    benchmarkPreset: defaultBenchmarkPreset,
    benchmarkRuns: null,
    skipBenchmark: false,
    skipTests: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    switch (token) {
      case "--idea": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--idea requires a value.");
        }

        args.idea = value;
        i += 1;
        break;
      }
      case "--status": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--status requires a value (winner|loser).");
        }

        const normalized = value.trim().toLowerCase();
        if (normalized !== "winner" && normalized !== "loser") {
          throw new Error("--status must be winner or loser.");
        }

        args.status = normalized;
        i += 1;
        break;
      }
      case "--parent": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--parent requires a snapshot id.");
        }

        args.parentId = value;
        i += 1;
        break;
      }
      case "--new-branch": {
        args.newBranch = true;
        break;
      }
      case "--benchmark-preset": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--benchmark-preset requires a value.");
        }

        args.benchmarkPreset = value;
        i += 1;
        break;
      }
      case "--benchmark-runs": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--benchmark-runs requires a value.");
        }

        const parsed = toPositiveInt(value, 0);
        if (parsed <= 0) {
          throw new Error("--benchmark-runs must be a positive integer.");
        }

        args.benchmarkRuns = parsed;
        i += 1;
        break;
      }
      case "--skip-benchmark": {
        args.skipBenchmark = true;
        break;
      }
      case "--skip-tests": {
        args.skipTests = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (args.idea.trim() === "") {
    throw new Error("--idea is required.");
  }

  if (args.status === "") {
    throw new Error("--status is required (winner|loser).");
  }

  return args;
}

export function parseAutoRecordArgs(argv, options = {}) {
  const defaultBenchmarkPreset = options.defaultBenchmarkPreset || "medium";
  const autoDecisionPresetIds = Array.isArray(options.autoDecisionPresetIds)
    ? options.autoDecisionPresetIds
    : ["quick", "medium", "balanced"];
  const args = {
    idea: "",
    parentId: null,
    newBranch: false,
    displayPreset: defaultBenchmarkPreset,
    benchmarkRuns: null,
    includeImmediateParent: false,
    skipTests: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    switch (token) {
      case "--idea": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--idea requires a value.");
        }

        args.idea = value;
        i += 1;
        break;
      }
      case "--parent": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--parent requires a snapshot id.");
        }

        args.parentId = value;
        i += 1;
        break;
      }
      case "--new-branch": {
        args.newBranch = true;
        break;
      }
      case "--display-preset": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error(`${token} requires a value.`);
        }

        if (!autoDecisionPresetIds.includes(value)) {
          throw new Error(
            `${token} for auto-record must be one of: ${autoDecisionPresetIds.join(", ")}`
          );
        }

        args.displayPreset = value;
        i += 1;
        break;
      }
      case "--benchmark-runs": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--benchmark-runs requires a value.");
        }

        const parsed = toPositiveInt(value, 0);
        if (parsed <= 0) {
          throw new Error("--benchmark-runs must be a positive integer.");
        }

        args.benchmarkRuns = parsed;
        i += 1;
        break;
      }
      case "--include-immediate-parent": {
        args.includeImmediateParent = true;
        break;
      }
      case "--skip-tests": {
        args.skipTests = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (args.idea.trim() === "") {
    throw new Error("--idea is required.");
  }

  return args;
}

export function summarizeTotals(report, options = {}) {
  const candidateSorterId = String(options.candidateSorterId || "");
  const nativeSorterId = String(options.nativeSorterId || NATIVE_SORTER.id);
  if (!report || !Array.isArray(report.sorterSummaries)) {
    return null;
  }

  const baseline = report.sorterSummaries.find((entry) => entry.id === nativeSorterId) || null;
  let candidate = report.sorterSummaries.find((entry) => entry.id === candidateSorterId) || null;

  if (!candidate) {
    for (let i = 0; i < report.sorterSummaries.length; i += 1) {
      const entry = report.sorterSummaries[i];
      if (entry && entry.id !== nativeSorterId) {
        candidate = entry;
        break;
      }
    }
  }

  if (!baseline || !candidate) {
    return null;
  }

  const improvementVsNativePct =
    baseline.avgMs > 0 ? ((baseline.avgMs - candidate.avgMs) / baseline.avgMs) * 100 : Number.NaN;

  const baselineSummary = {
    avgMs: baseline.avgMs,
    p50Ms: baseline.p50Ms,
    p75Ms: baseline.p75Ms,
    p95Ms: baseline.p95Ms,
    sampleCount: baseline.sampleCount,
  };
  const candidateSummary = {
    avgMs: candidate.avgMs,
    p50Ms: candidate.p50Ms,
    p75Ms: candidate.p75Ms,
    p95Ms: candidate.p95Ms,
    sampleCount: candidate.sampleCount,
  };

  return {
    rowCount: report.rowCount,
    runsPerCase: report.runsPerCase,
    totalBenchmarkMs: report.totalBenchmarkMs,
    baseline: baselineSummary,
    candidate: candidateSummary,
    improvementVsNativePct,
    comparison: report.comparison
      ? {
          metric: report.comparison.metric,
          geomeanScoreP50: report.comparison.geomeanScoreP50,
          geomeanImprovementP50Pct: report.comparison.geomeanImprovementP50Pct,
          caseCount: Array.isArray(report.comparison.cases) ? report.comparison.cases.length : 0,
        }
      : null,
  };
}

function extractPresetScoreFromTotals(totals) {
  return Number(totals?.comparison?.geomeanScoreP50);
}

export function computePresetDeltaPct(parentScore, currentScore) {
  if (!Number.isFinite(parentScore) || parentScore <= 0 || !Number.isFinite(currentScore)) {
    return Number.NaN;
  }
  return ((parentScore - currentScore) / parentScore) * 100;
}

export function buildDecisionSuiteSummary(presetTotalsById, presetIds) {
  const normalizedPresetIds = Array.isArray(presetIds) ? presetIds : [];
  const byPreset = Object.create(null);
  const scores = [];

  for (let i = 0; i < normalizedPresetIds.length; i += 1) {
    const presetId = normalizedPresetIds[i];
    const totals = presetTotalsById ? presetTotalsById[presetId] : null;
    const score = extractPresetScoreFromTotals(totals);
    const improvementVsNativePct = Number(totals?.comparison?.geomeanImprovementP50Pct);

    byPreset[presetId] = {
      score,
      improvementVsNativePct,
      rowCount: Number(totals?.rowCount),
      runsPerCase: Number(totals?.runsPerCase),
    };

    if (Number.isFinite(score) && score > 0) {
      scores.push(score);
    }
  }

  const overallScore = geometricMeanPositive(scores);
  return {
    presetIds: normalizedPresetIds.slice(),
    presetCount: normalizedPresetIds.length,
    byPreset,
    overallScore,
  };
}

export function computeDeltaVsParent(currentTotals, parentSnapshot, candidateMetrics) {
  if (!currentTotals || !parentSnapshot || !parentSnapshot.benchmarkTotals) {
    return {
      pct: Number.NaN,
      direction: "unknown",
    };
  }

  const parentAvg = Number(candidateMetrics(parentSnapshot.benchmarkTotals)?.avgMs);
  const currentAvg = Number(candidateMetrics(currentTotals)?.avgMs);
  if (!Number.isFinite(parentAvg) || !Number.isFinite(currentAvg) || parentAvg <= 0) {
    return {
      pct: Number.NaN,
      direction: "unknown",
    };
  }

  const pct = ((parentAvg - currentAvg) / parentAvg) * 100;
  let direction = "equal";
  if (pct > 0) {
    direction = "better";
  } else if (pct < 0) {
    direction = "worse";
  }

  return {
    pct,
    direction,
  };
}

export function buildSnapshotRecord(params) {
  const progressId = params.args.status === "winner"
    ? params.snapshotId
    : params.parentSnapshot.progressId || params.parentSnapshot.id || params.rootId;

  const deltaVsParent = computeDeltaVsParent(
    params.benchmarkTotals,
    params.parentSnapshot,
    params.candidateMetrics
  );

  return {
    id: params.snapshotId,
    file: params.fileName,
    hash: params.fileHash,
    status: params.args.status,
    idea: params.args.idea,
    parentId: params.parentSnapshot.id,
    progressId,
    branchPath: params.branch.path,
    rootBranch: params.branch.path.split(".")[0],
    branch: {
      fromId: params.branch.fromId,
      path: params.branch.path,
      depth: params.branch.depth,
      slot: params.branch.slot,
    },
    benchmarkPresetId: params.args.skipBenchmark ? null : params.args.benchmarkPreset,
    benchmarkTotals: params.benchmarkTotals,
    deltaVsParentPct: deltaVsParent.pct,
    deltaVsParentDirection: deltaVsParent.direction,
    tests: params.testSummary,
    createdAt: params.nowIso(),
  };
}

export async function runBenchmarkForSnapshot(args, options) {
  const preset = findBenchmarkPresetById(args.benchmarkPreset);
  if (!preset) {
    throw new Error(`Unknown benchmark preset: ${String(args.benchmarkPreset || "")}`);
  }
  const rows = generateRows(preset.rowCount, {
    seed: preset.seed,
  });

  const sortFn = await loadSortFunctionFromFile(options.workingFile);
  const candidateSorter = createSharedSorter(
    options.candidateSorterId,
    options.candidateLabel,
    sortFn
  );

  const report = runSortBenchmark(rows, {
    runs: args.benchmarkRuns !== null ? args.benchmarkRuns : preset.runs,
    profile: options.runtimeProfile,
    sorters: [NATIVE_SORTER, candidateSorter],
    candidateSorter,
    validateSorted: true,
  });

  return summarizeTotals(report, {
    nativeSorterId: NATIVE_SORTER.id,
    candidateSorterId: options.candidateSorterId,
  });
}

export async function loadSortFunctionFromFile(sorterFilePath) {
  const absolutePath = path.resolve(sorterFilePath);
  const fileUrl = pathToFileURL(absolutePath);
  fileUrl.searchParams.set("cacheBust", String(Date.now()));
  const moduleValue = await import(fileUrl.href);
  const sortFn = moduleValue && typeof moduleValue.default === "function"
    ? moduleValue.default
    : null;

  if (!sortFn) {
    throw new Error(`Sorter file does not export a default sort function: ${sorterFilePath}`);
  }

  return sortFn;
}

export async function resolveAnchorSorterFilePath(metadata, anchorSnapshot, options) {
  const sourceFilePathRaw = anchorSnapshot.id === options.rootId
    ? metadata.root.file
    : anchorSnapshot.file;
  const sourceFilePath = await options.resolveSnapshotFilePath(sourceFilePathRaw);
  if (!sourceFilePath) {
    throw new Error(`Snapshot file path unavailable for ${anchorSnapshot.id}`);
  }
  if (!(await options.fileExists(sourceFilePath))) {
    throw new Error(`Snapshot file not found: ${sourceFilePathRaw}`);
  }

  return sourceFilePath;
}

export async function runSharedDecisionBenchmarkSuite(params) {
  const candidateSortFn = await loadSortFunctionFromFile(params.workingFile);
  const anchorFilePath = await resolveAnchorSorterFilePath(params.metadata, params.anchorSnapshot, {
    rootId: params.rootId,
    resolveSnapshotFilePath: params.resolveSnapshotFilePath,
    fileExists: params.fileExists,
  });
  const anchorSortFn = await loadSortFunctionFromFile(anchorFilePath);
  const candidateSorter = createSharedSorter("candidate", path.basename(params.workingFile), candidateSortFn);
  const anchorSorter = createSharedSorter("anchor", path.basename(anchorFilePath), anchorSortFn);
  const includeImmediateParent = params.args?.includeImmediateParent === true;
  let immediateParentSorter = null;
  let immediateParentFilePath = "";
  let immediateParentIsAnchor = false;

  if (includeImmediateParent && params.parentSnapshot) {
    if (params.parentSnapshot.id === params.anchorSnapshot.id) {
      immediateParentSorter = anchorSorter;
      immediateParentFilePath = anchorFilePath;
      immediateParentIsAnchor = true;
    } else {
      immediateParentFilePath = await resolveAnchorSorterFilePath(params.metadata, params.parentSnapshot, {
        rootId: params.rootId,
        resolveSnapshotFilePath: params.resolveSnapshotFilePath,
        fileExists: params.fileExists,
      });
      const immediateParentSortFn = await loadSortFunctionFromFile(immediateParentFilePath);
      immediateParentSorter = createSharedSorter(
        "immediate_parent",
        path.basename(immediateParentFilePath),
        immediateParentSortFn
      );
    }
  }

  const sorters = [NATIVE_SORTER, anchorSorter];
  const targetSorterIds = [anchorSorter.id];
  if (immediateParentSorter && immediateParentSorter.id !== anchorSorter.id) {
    sorters.push(immediateParentSorter);
    targetSorterIds.push(immediateParentSorter.id);
  }
  sorters.push(candidateSorter);
  targetSorterIds.push(candidateSorter.id);

  const suite = runSharedPresetSuite({
    presetIds: params.settings.presetIds,
    sorters,
    baselineSorterId: NATIVE_SORTER.id,
    targetSorterIds,
    benchmarkRunsOverride: params.args.benchmarkRuns,
    directions: params.settings.directions,
    orderMode: params.settings.orderMode,
    abTesting: params.settings.abTesting,
    useWarmup: USE_WARMUP,
    warmupRunsPerCombination: params.settings.warmupRunsPerCombination,
    storeRawRuns: params.settings.storeRawRuns,
    validateSorted: true,
  });
  const currentTotalsByPreset = suite.totalsByTargetId[candidateSorter.id] || Object.create(null);
  const anchorTotalsByPreset = suite.totalsByTargetId[anchorSorter.id] || Object.create(null);
  const immediateParentTotalsByPreset = immediateParentSorter
    ? immediateParentIsAnchor
      ? anchorTotalsByPreset
      : suite.totalsByTargetId[immediateParentSorter.id] || Object.create(null)
    : null;

  return {
    currentTotalsByPreset,
    anchorTotalsByPreset,
    immediateParentTotalsByPreset,
    immediateParentSuite: immediateParentTotalsByPreset
      ? buildDecisionSuiteSummary(immediateParentTotalsByPreset, params.settings.presetIds)
      : null,
    rawRunsByPreset: suite.rawRunsByPreset,
    suiteMeasuredTotalMs: Number(suite.suiteMeasuredTotalMs),
    suiteWarmupTotalMs: Number(suite.suiteWarmupTotalMs),
    currentSuiteBenchmarkTotalMs: Number(suite.suiteBenchmarkTotalMsByTargetId[candidateSorter.id]),
    anchorSuiteBenchmarkTotalMs: Number(suite.suiteBenchmarkTotalMsByTargetId[anchorSorter.id]),
    immediateParentSuiteBenchmarkTotalMs: immediateParentSorter
      ? immediateParentIsAnchor
        ? Number(suite.suiteBenchmarkTotalMsByTargetId[anchorSorter.id])
        : Number(suite.suiteBenchmarkTotalMsByTargetId[immediateParentSorter.id])
      : Number.NaN,
    combinedSuiteBenchmarkTotalMs: Number(suite.combinedSuiteBenchmarkTotalMs),
    benchmarkFlow: immediateParentSorter
      ? "shared_preset_session_native_anchor_immediate_parent_candidate"
      : "shared_preset_session_native_anchor_candidate",
    immediateParent: immediateParentSorter
      ? {
          id: params.parentSnapshot.id,
          sorterId: immediateParentSorter.id,
          file: immediateParentFilePath,
          isAnchor: immediateParentIsAnchor,
        }
      : null,
    abTestingEnabled: Boolean(suite.abTestingEnabled),
    orderMode: String(suite.orderMode),
  };
}

export function summarizeTestResults(summary) {
  return {
    passed: Number(summary?.passed || 0),
    failed: Number(summary?.failed || 0),
    total: Number(summary?.total || 0),
    totalMs: Number(summary?.totalMs || 0),
  };
}

export function summarizeCommandTestResult(exitCode, totalMs, message = "") {
  const success = Number(exitCode) === 0;
  return {
    passed: success ? 1 : 0,
    failed: success ? 0 : 1,
    total: 1,
    totalMs,
    message,
  };
}

export async function runConfiguredUnitTestSuite(runtimeProfile) {
  const runner = runtimeProfile.testRunner || {};
  if (runner.type === "command") {
    const command = String(runner.command || "").trim();
    if (command === "") {
      throw new Error("Test runner command is empty.");
    }

    const startMs = Date.now();
    const result = spawnSync(command, {
      shell: true,
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });
    const totalMs = Date.now() - startMs;
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    if (stdout !== "") {
      console.log(stdout);
    }
    if (stderr !== "") {
      console.error(stderr);
    }
    const summary = summarizeCommandTestResult(
      typeof result.status === "number" ? result.status : 1,
      totalMs,
      stderr || stdout
    );
    return summarizeTestResults(summary);
  }

  const modulePath = path.resolve(
    String(runner.modulePath || "./unit-tests-core.js")
  );
  const moduleUrl = pathToFileURL(modulePath);
  moduleUrl.searchParams.set("testRunner", String(Date.now()));
  const moduleValue = await import(moduleUrl.href);
  const exportName = String(runner.exportName || "runUnitTestSuite");
  const testFn = moduleValue && typeof moduleValue[exportName] === "function"
    ? moduleValue[exportName]
    : null;
  if (!testFn) {
    throw new Error(
      `Test runner export "${exportName}" not found in ${modulePath}.`
    );
  }

  const baseRunnerOptions =
    runner.options && typeof runner.options === "object"
      ? runner.options
      : { stopOnFail: false };
  const rawResult = await testFn({
    ...baseRunnerOptions,
    profile: runtimeProfile,
  });
  return summarizeTestResults(rawResult);
}

export async function runNodeSyntaxCheck(filePath) {
  const absolutePath = path.resolve(filePath);
  const result = spawnSync(process.execPath, ["--check", absolutePath], {
    shell: false,
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
  });

  if (typeof result.status === "number" && result.status === 0) {
    return {
      ok: true,
      message: "",
    };
  }

  const spawnErrorCode = String(result.error?.code || "").trim().toUpperCase();
  if (spawnErrorCode === "EPERM") {
    try {
      const moduleUrl = pathToFileURL(absolutePath);
      moduleUrl.searchParams.set("syntaxProbe", String(Date.now()));
      await import(moduleUrl.href);
      return {
        ok: true,
        message: "",
      };
    } catch (error) {
      const fallbackMessage = String(error?.message || error || "").trim();
      return {
        ok: false,
        message: fallbackMessage || "Syntax check failed.",
      };
    }
  }

  const message = String(result.stderr || result.stdout || result.error?.message || "").trim();
  return {
    ok: false,
    message: message || "Syntax check failed.",
  };
}

export function decideAutoStatus(params) {
  const testsFailed = Number(params.testSummary?.failed || 0);
  const settings = params.settings;
  const anchorSuite = buildDecisionSuiteSummary(params.anchorSuiteTotalsByPreset, settings.presetIds);
  const currentSuite = buildDecisionSuiteSummary(params.currentSuiteTotalsByPreset, settings.presetIds);

  const presetDeltas = [];
  let allPresetComparable = true;
  for (let i = 0; i < settings.presetIds.length; i += 1) {
    const presetId = settings.presetIds[i];
    const parentScore = Number(anchorSuite.byPreset[presetId]?.score);
    const currentScore = Number(currentSuite.byPreset[presetId]?.score);
    const deltaPct = computePresetDeltaPct(parentScore, currentScore);
    if (!Number.isFinite(parentScore) || parentScore <= 0 || !Number.isFinite(currentScore) || currentScore <= 0) {
      allPresetComparable = false;
    }

    presetDeltas.push({
      presetId,
      parentScore,
      currentScore,
      deltaPct,
      parentImprovementVsNativePct: Number(anchorSuite.byPreset[presetId]?.improvementVsNativePct),
      currentImprovementVsNativePct: Number(currentSuite.byPreset[presetId]?.improvementVsNativePct),
    });
  }

  const parentOverallScore = Number(anchorSuite.overallScore);
  const currentOverallScore = Number(currentSuite.overallScore);
  const overallImprovementPct = computePresetDeltaPct(parentOverallScore, currentOverallScore);
  const overallComparable =
    Number.isFinite(parentOverallScore) &&
    parentOverallScore > 0 &&
    Number.isFinite(currentOverallScore) &&
    currentOverallScore > 0 &&
    Number.isFinite(overallImprovementPct);
  const canCompare =
    allPresetComparable &&
    (settings.mode === "pareto" ? true : overallComparable);

  const targetPresetIdSet = Object.create(null);
  for (let i = 0; i < settings.paretoTargetPresetIds.length; i += 1) {
    targetPresetIdSet[settings.paretoTargetPresetIds[i]] = true;
  }

  const paretoTargetHits = [];
  for (let i = 0; i < presetDeltas.length; i += 1) {
    const item = presetDeltas[i];
    if (
      targetPresetIdSet[item.presetId] === true &&
      Number.isFinite(item.deltaPct) &&
      item.deltaPct >= settings.paretoMinTargetImprovementPct
    ) {
      paretoTargetHits.push(item);
    }
  }
  const paretoTargetPassed = paretoTargetHits.length > 0;

  const activeGuardrailMaxRegressionPct =
    settings.mode === "pareto"
      ? settings.paretoMaxPresetRegressionPct
      : settings.overallMaxPresetRegressionPct;
  const guardrailBreaches = presetDeltas.filter(
    (item) => Number.isFinite(item.deltaPct) && item.deltaPct < -activeGuardrailMaxRegressionPct
  );
  const guardrailPassed = guardrailBreaches.length === 0;

  const overallPassed =
    overallComparable && overallImprovementPct >= settings.overallWinThresholdPct;

  const decisionPassed =
    settings.mode === "pareto"
      ? paretoTargetPassed && guardrailPassed
      : overallPassed && guardrailPassed;

  const status = testsFailed === 0 && canCompare && decisionPassed ? "winner" : "loser";
  const primaryMetric =
    settings.mode === "pareto"
      ? "pareto_target_and_guardrail_p50"
      : "overall_geomean_score_p50";
  const thresholdImprovementPct =
    settings.mode === "pareto"
      ? settings.paretoMinTargetImprovementPct
      : settings.overallWinThresholdPct;

  return {
    status,
    improvementPct: overallImprovementPct,
    canCompare,
    overallComparable,
    parentOverallScore,
    currentOverallScore,
    testsFailed,
    decisionMode: settings.mode,
    primaryMetric,
    thresholdImprovementPct,
    guardrailMaxRegressionPct: activeGuardrailMaxRegressionPct,
    decisionPassed,
    overallPassed,
    paretoTargetPassed,
    paretoTargetHits,
    paretoTargetPresetIds: settings.paretoTargetPresetIds.slice(),
    guardrailPassed,
    presetDeltas,
    guardrailBreaches,
    parentSuite: anchorSuite,
    currentSuite,
  };
}

export const DECISION_USE_WARMUP = USE_WARMUP;

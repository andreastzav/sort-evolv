import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEvolutionGraphArtifacts } from "./evolution_graph_core.js";
import {
  evolutionDirForBase,
  resolveActiveSortingProfile,
  resolveFallbackSortingProfile,
  snapshotDirForBase,
  snapshotFileNameFromId,
} from "./sorting_profile_core.js";
import {
  normalizeBaseFileName as normalizeRootBaseFileName,
  resolveHelpSortingProfile,
  stripGlobalSortingArgs,
  toPositiveInt
} from "./cli_arg_utils_core.js";
import {
  ROOT_SNAPSHOT_ID,
  buildNextWorkPlan as buildPlannerNextWorkPlan,
  resolveBranchForSnapshot as resolvePlannerBranchForSnapshot,
} from "./orchestrator_planner_core.js";
import {
  ORCHESTRATOR_BRANCH_LIMITS,
  ORCHESTRATOR_DECISION_THRESHOLDS,
  ORCHESTRATOR_LOCAL_BEAM_POLICY,
  createPlannerDefaults as createOrchestratorPlannerDefaults,
} from "./orchestrator_policy_core.js";

let runtimeProfile = resolveFallbackSortingProfile();

const ROOT_ID = ROOT_SNAPSHOT_ID;

const WIN_THRESHOLD_PCT = ORCHESTRATOR_DECISION_THRESHOLDS.overallWinThresholdPct;

function defaultBaseFile() {
  return `${runtimeProfile.sortingId}_base_0120.js`;
}

function plannerDefaults() {
  return createOrchestratorPlannerDefaults(ROOT_ID);
}

function fakeMetadataFileName(fileName) {
  const text = String(fileName || "");
  if (text.toLowerCase().endsWith(".json")) {
    return `${text.slice(0, -5)}.fake.json`;
  }
  return `${text}.fake.json`;
}

function createDefaultArgs() {
  return {
    baseFile: defaultBaseFile(),
    outputJson: "",
    seed: 20260321,
    maxRootBranches: ORCHESTRATOR_BRANCH_LIMITS.maxRootBranches,
    maxChildVariantsPerWinner: ORCHESTRATOR_BRANCH_LIMITS.maxChildVariantsPerWinner,
    maxSpeculativeLosses: ORCHESTRATOR_BRANCH_LIMITS.maxSpeculativeLosses,
    winThresholdPct: WIN_THRESHOLD_PCT,
    maxSnapshots: 1000,
    baseNativeMs: 145,
    baseCandidateMs: 120,
    benchmarkPresetId: "medium",
    rowCount: 50000,
    runsPerCase: 3,
    sortCaseCount: 15,
    title: `Synthetic ${runtimeProfile.candidateLabel} Evolution`
  };
}

const SYNTHETIC_DISTRIBUTION = Object.freeze({
  better1Pct: 0.30,
  better2Pct: 0.10,
  better3Pct: 0.05
});

const WINNER_IDEA_PARTS = Object.freeze([
  "gallop threshold tuning",
  "merge loop bounds hoist",
  "run stack write reduction",
  "fewer temp array touches",
  "branchless compare tweak",
  "early-exit in mergeLo"
]);

const LOSER_IDEA_PARTS = Object.freeze([
  "over-aggressive threshold change",
  "extra branch in collapse",
  "speculative path with cache misses",
  "too much loop unrolling",
  "added guard path in hot loop",
  "allocation-heavy merge variant"
]);

function printHelp() {
  const evolutionRoot = `${runtimeProfile.rootDir}/${runtimeProfile.evolutionDirName}`;
  console.log(`synthetic ${runtimeProfile.candidateLabel} evolution simulator`);
  console.log("");
  console.log("Usage:");
  console.log("  node simulate_evolution_cli.js [options]");
  console.log("");
  console.log("Options:");
  console.log(
    `  --base-file <name>.js                   Base context for output folders (default: ${defaultBaseFile()}).`
  );
  console.log("  --output-json <file>                     Output metadata JSON (forced to *.fake.json).");
  console.log("  --output-svg <file>                      Output graph SVG (forced to *.fake.svg).");
  console.log("  --output-html <file>                     Output graph HTML (forced to *.fake.html).");
  console.log("  --seed <number>                          RNG seed.");
  console.log("  --max-root-branches <int>                Root child variant slots.");
  console.log("  --max-child-variants-per-winner <int>    Child variant slots for non-root winners.");
  console.log("  --max-speculative-losses <int>           Loss family budget per variant.");
  console.log("  --win-threshold-pct <number>             Winner threshold vs anchor score.");
  console.log("  --max-snapshots <int>                    Hard cap for generated snapshots.");
  console.log("  --base-native-ms <number>                Baseline native avg ms.");
  console.log(
    `  --base-candidate-ms <number>             Baseline ${runtimeProfile.candidateLabel} avg ms.`
  );
  console.log("  --title <text>                           Graph title.");
  console.log("  --help                                   Show help.");
  console.log("");
  console.log("Defaults:");
  console.log(
    `  output base dir: ${evolutionRoot}/<base-stem>/ (metadata/svg/html use *.fake.* names).`
  );
  console.log(
    `  local beam: width=${ORCHESTRATOR_LOCAL_BEAM_POLICY.localBeamWidth}, max loser children=${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxChildrenPerLoser}, ugly continuations=${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxUglyContinuationsPerFamily}.`
  );
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round6(value) {
  return Math.round(value * 1000000) / 1000000;
}

function createMulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(random, minValue, maxValue) {
  return minValue + random() * (maxValue - minValue);
}

function formatSnapshotId(numberValue) {
  return String(numberValue).padStart(4, "0");
}

function splitRootBranch(branchPath) {
  if (typeof branchPath !== "string" || branchPath.trim() === "") {
    return "ROOT";
  }
  return branchPath.split(".")[0];
}

function createSyntheticIdea(status, deltaPct, branchPath, depth, random) {
  const pool = status === "winner" ? WINNER_IDEA_PARTS : LOSER_IDEA_PARTS;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const directionText = deltaPct >= 0 ? "faster" : "slower";
  return `${pool[index]} on ${branchPath} depth ${depth} (${Math.abs(deltaPct).toFixed(
    2
  )}% ${directionText})`;
}

function makeMetricSummary(avgMs, sampleCount, random) {
  const p50 = avgMs * randomRange(random, 0.97, 1.02);
  const p75 = Math.max(p50, avgMs * randomRange(random, 1.04, 1.16));
  const p95 = Math.max(p75, avgMs * randomRange(random, 1.14, 1.34));
  return {
    avgMs: round2(avgMs),
    p50Ms: round2(p50),
    p75Ms: round2(p75),
    p95Ms: round2(p95),
    sampleCount
  };
}

function createBenchmarkTotals(candidateAvgMs, baselineAvgMs, sampleCount, random, config) {
  const baseline = makeMetricSummary(baselineAvgMs, sampleCount, random);
  const candidate = makeMetricSummary(candidateAvgMs, sampleCount, random);
  const improvementVsNativePct =
    baseline.avgMs > 0
      ? ((baseline.avgMs - candidate.avgMs) / baseline.avgMs) * 100
      : Number.NaN;
  const totalBenchmarkMs =
    (baseline.avgMs + candidate.avgMs) *
    sampleCount *
    randomRange(random, 1.45, 1.95) *
    randomRange(random, 0.98, 1.02);
  const scoreP50 = baseline.p50Ms > 0 ? candidate.p50Ms / baseline.p50Ms : Number.NaN;
  const improvementP50Pct = Number.isFinite(scoreP50) ? (1 - scoreP50) * 100 : Number.NaN;

  return {
    rowCount: config.rowCount,
    runsPerCase: config.runsPerCase,
    totalBenchmarkMs: round2(totalBenchmarkMs),
    baseline,
    candidate,
    improvementVsNativePct,
    comparison: {
      metric: "p50_ratio",
      geomeanScoreP50: round6(scoreP50),
      geomeanImprovementP50Pct: round2(improvementP50Pct)
    }
  };
}

function scoreFromBenchmarkTotals(benchmarkTotals) {
  const fromComparison = Number(benchmarkTotals?.comparison?.geomeanScoreP50);
  if (Number.isFinite(fromComparison) && fromComparison > 0) {
    return fromComparison;
  }

  const baselineP50 = Number(benchmarkTotals?.baseline?.p50Ms ?? benchmarkTotals?.native?.p50Ms);
  const candidateP50 = Number(benchmarkTotals?.candidate?.p50Ms);
  if (
    Number.isFinite(baselineP50) &&
    baselineP50 > 0 &&
    Number.isFinite(candidateP50) &&
    candidateP50 > 0
  ) {
    return candidateP50 / baselineP50;
  }

  return Number.NaN;
}

function computeImprovementPct(referenceScore, candidateScore) {
  const base = Number(referenceScore);
  const current = Number(candidateScore);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(current) || current <= 0) {
    return Number.NaN;
  }

  return ((base - current) / base) * 100;
}

function createOutcomeDeck(random) {
  const deck = [];
  const deckSize = 20;
  const better1Count = Math.round(deckSize * SYNTHETIC_DISTRIBUTION.better1Pct);
  const better2Count = Math.round(deckSize * SYNTHETIC_DISTRIBUTION.better2Pct);
  const better3Count = Math.round(deckSize * SYNTHETIC_DISTRIBUTION.better3Pct);
  const worseCount = Math.max(0, deckSize - better1Count - better2Count - better3Count);

  for (let i = 0; i < better1Count; i += 1) {
    deck.push(1);
  }
  for (let i = 0; i < better2Count; i += 1) {
    deck.push(2);
  }
  for (let i = 0; i < better3Count; i += 1) {
    deck.push(3);
  }
  for (let i = 0; i < worseCount; i += 1) {
    deck.push(-(3 + random() * 2));
  }

  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = deck[i];
    deck[i] = deck[j];
    deck[j] = temp;
  }

  return deck;
}

function createSyntheticOutcomeProvider(random) {
  let deck = [];
  let index = 0;

  function nextDeltaPct() {
    if (index >= deck.length) {
      deck = createOutcomeDeck(random);
      index = 0;
    }

    const nextValue = deck[index];
    index += 1;
    return nextValue;
  }

  return {
    next(parentNode) {
      const deltaPct = nextDeltaPct();
      const candidateAvgMs = Math.max(1, parentNode.candidateAvgMs * (1 - deltaPct / 100));
      const baselineNoisePct = randomRange(random, -1.0, 1.0);
      const baselineAvgMs = Math.max(1, parentNode.baselineAvgMs * (1 + baselineNoisePct / 100));
      return {
        deltaPct,
        candidateAvgMs,
        baselineAvgMs
      };
    }
  };
}

function createInitialMetadata(config, rootTotals) {
  const createdAt = new Date().toISOString();
  const rootScore = scoreFromBenchmarkTotals(rootTotals);
  return {
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    files: {
      working: runtimeProfile.workingFile,
      original: config.baseFile,
      snapshots: config.snapshotDir
    },
    constraints: {
      maxRootBranches: config.maxRootBranches,
      maxChildVariantsPerWinner: config.maxChildVariantsPerWinner,
      maxSpeculativeLosses: config.maxSpeculativeLosses
    },
    root: {
      id: ROOT_ID,
      file: config.baseFile,
      hash: "synthetic-root-hash",
      createdAt,
      status: "winner",
      branchPath: "ROOT",
      progressId: ROOT_ID,
      parentId: null,
      note: "Synthetic immutable baseline",
      scoreP50: rootScore,
      benchmarkTotals: rootTotals
    },
    counters: {
      nextSnapshotNumber: 1
    },
    snapshots: []
  };
}

function buildSimulationState(config) {
  const random = createMulberry32(config.seed);
  const sampleCount = config.sortCaseCount * 2 * config.runsPerCase;
  const rootTotals = createBenchmarkTotals(
    config.baseCandidateMs,
    config.baseNativeMs,
    sampleCount,
    random,
    config
  );
  const rootScore = scoreFromBenchmarkTotals(rootTotals);
  const metadata = createInitialMetadata(config, rootTotals);
  const nodesById = new Map();
  nodesById.set(ROOT_ID, {
    id: ROOT_ID,
    candidateAvgMs: rootTotals.candidate.avgMs,
    baselineAvgMs: rootTotals.baseline.avgMs,
    scoreP50: rootScore,
    progressId: ROOT_ID,
    status: "winner",
    branchPath: "ROOT",
    parentId: null,
    winnerParentId: null,
    variantRootId: ROOT_ID,
    variantStep: 0,
    speculativeLossCount: 0
  });

  return {
    config,
    random,
    sampleCount,
    metadata,
    nodesById,
    snapshotCounter: 0,
    outcomeProvider: createSyntheticOutcomeProvider(random)
  };
}

function nextCreatedAt(snapshotCounter) {
  const baseTimestamp = Date.UTC(2026, 2, 21, 4, 0, 0);
  const stepMs = 2 * 60 * 1000;
  return new Date(baseTimestamp + snapshotCounter * stepMs).toISOString();
}

function getRecordById(metadata, snapshotId) {
  if (snapshotId === ROOT_ID) {
    return metadata.root;
  }

  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  for (let i = 0; i < snapshots.length; i += 1) {
    if (snapshots[i].id === snapshotId) {
      return snapshots[i];
    }
  }

  return null;
}

function buildNextWorkPlan(state) {
  return buildPlannerNextWorkPlan(state.metadata, state.config, plannerDefaults());
}

function buildBranchMeta(state, parentRecord, plan) {
  return resolvePlannerBranchForSnapshot(
    state.metadata,
    parentRecord,
    {
      newBranch: plan.newBranch === true || plan.newVariant === true,
      anchorId: plan.anchorId,
    },
    state.config,
    plannerDefaults()
  );
}

function registerSnapshotRecord(state, parentRecord, parentNode, anchorNode, plan, outcome) {
  const nextNumber = state.metadata.counters.nextSnapshotNumber;
  const snapshotId = formatSnapshotId(nextNumber);
  const benchmarkTotals = createBenchmarkTotals(
    outcome.candidateAvgMs,
    outcome.baselineAvgMs,
    state.sampleCount,
    state.random,
    state.config
  );
  const scoreP50 = scoreFromBenchmarkTotals(benchmarkTotals);
  const deltaVsParentPct = computeImprovementPct(parentNode.scoreP50, scoreP50);
  const deltaVsAnchorPct = computeImprovementPct(anchorNode.scoreP50, scoreP50);
  const isWinner =
    Number.isFinite(deltaVsAnchorPct) && deltaVsAnchorPct >= state.config.winThresholdPct;
  const status = isWinner ? "winner" : "loser";
  const branchMeta = buildBranchMeta(state, parentRecord, plan);
  const startsNewVariant = plan.newVariant === true;
  const parentVariantStep = Number(parentRecord.variantStep);
  const plannedFamilyLossCount = Number(plan?.speculativeLossCount);
  const variantStep =
    startsNewVariant
      ? 1
      : Number.isFinite(plannedFamilyLossCount) && plannedFamilyLossCount >= 0
        ? plannedFamilyLossCount + 1
      : Number.isFinite(parentVariantStep) && parentVariantStep >= 1
        ? parentVariantStep + 1
        : 2;
  const parentSpecLoss = Number(parentRecord.speculativeLossCount);
  const baseSpecLoss =
    Number.isFinite(plannedFamilyLossCount) && plannedFamilyLossCount >= 0
      ? plannedFamilyLossCount
      : Number.isFinite(parentSpecLoss) && parentSpecLoss >= 0
        ? parentSpecLoss
        : 0;
  const speculativeLossCount =
    status === "winner"
      ? 0
      : startsNewVariant
        ? 1
        : baseSpecLoss + 1;
  const variantRootId =
    startsNewVariant
      ? snapshotId
      : typeof parentRecord.variantRootId === "string" && parentRecord.variantRootId !== ""
        ? parentRecord.variantRootId
        : parentRecord.id;
  const progressId = status === "winner" ? snapshotId : anchorNode.id;
  const createdAt = nextCreatedAt(state.snapshotCounter);

  const record = {
    id: snapshotId,
    file: path.join(
      state.config.snapshotDir,
      snapshotFileNameFromId(snapshotId, runtimeProfile)
    ),
    hash: `synthetic-${snapshotId}`,
    status,
    idea: createSyntheticIdea(status, Number(outcome.deltaPct), branchMeta.path, branchMeta.depth, state.random),
    parentId: parentRecord.id,
    progressId,
    branchPath: branchMeta.path,
    rootBranch: splitRootBranch(branchMeta.path),
    branch: {
      fromId: branchMeta.fromId,
      path: branchMeta.path,
      depth: branchMeta.depth,
      slot: branchMeta.slot
    },
    benchmarkPresetId: state.config.benchmarkPresetId,
    benchmarkTotals,
    scoreP50,
    deltaVsParentPct,
    deltaVsParentDirection:
      deltaVsParentPct > 0 ? "better" : deltaVsParentPct < 0 ? "worse" : "equal",
    anchorId: anchorNode.id,
    anchorScore: anchorNode.scoreP50,
    deltaVsAnchorPct,
    variantRootId,
    variantStep,
    speculativeLossCount,
    syntheticDeltaPct: Number(outcome.deltaPct),
    decision: {
      mode: "auto-simulated",
      primaryMetric: "score_p50",
      thresholdImprovementPct: state.config.winThresholdPct,
      anchorId: anchorNode.id,
      anchorScore: anchorNode.scoreP50,
      candidateScore: scoreP50,
      deltaVsAnchorPct,
      overallDeltaVsAnchorPct: deltaVsAnchorPct,
      guardrailPassed: true,
      guardrailBreaches: [],
      usedPlan: plan
        ? {
            reason: plan.reason,
            selectionKind: plan.localBeam?.selectionKind || (plan.newVariant ? "new-variant" : "strict"),
            progressPointId: plan.progressPointId,
            selectedParentId: plan.parentId,
            branchPath: plan.branchPath,
            parentDepth: plan.parentDepth,
            familyRootId: plan.familyRootId || null,
            speculativeLossCount: Number.isFinite(Number(plan.speculativeLossCount))
              ? Number(plan.speculativeLossCount)
              : null,
            localBeam: plan.localBeam || null
          }
        : null
    },
    tests: {
      passed: 7,
      failed: 0,
      total: 7,
      totalMs: round2(randomRange(state.random, 145, 175))
    },
    createdAt
  };

  state.metadata.snapshots.push(record);
  state.metadata.counters.nextSnapshotNumber = nextNumber + 1;
  state.snapshotCounter += 1;
  state.metadata.updatedAt = createdAt;

  const runtimeNode = {
    id: snapshotId,
    candidateAvgMs: benchmarkTotals.candidate.avgMs,
    baselineAvgMs: benchmarkTotals.baseline.avgMs,
    scoreP50,
    progressId,
    status,
    branchPath: branchMeta.path,
    parentId: parentRecord.id,
    winnerParentId: status === "winner" ? anchorNode.id : null,
    anchorId: anchorNode.id,
    variantRootId,
    variantStep,
    speculativeLossCount
  };

  state.nodesById.set(snapshotId, runtimeNode);
  return runtimeNode;
}

function runOrchestrator(state) {
  let safetyCounter = state.config.maxSnapshots * 20;
  while (state.metadata.snapshots.length < state.config.maxSnapshots && safetyCounter > 0) {
    safetyCounter -= 1;
    const plan = buildNextWorkPlan(state);
    if (!plan.found) {
      break;
    }

    const parentRecord = getRecordById(state.metadata, plan.parentId);
    const parentNode = state.nodesById.get(plan.parentId);
    const anchorNode = state.nodesById.get(plan.anchorId);
    if (!parentRecord || !parentNode || !anchorNode) {
      break;
    }

    const outcome = state.outcomeProvider.next(parentNode);
    registerSnapshotRecord(state, parentRecord, parentNode, anchorNode, plan, outcome);
  }

  if (safetyCounter <= 0) {
    throw new Error("Simulation safety limit reached before orchestrator finished.");
  }
}

function summarizeSimulation(metadata) {
  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  let winners = 0;
  let losers = 0;
  let maxSpeculativeLossesObserved = 0;
  const distribution = {
    better1: 0,
    better2: 0,
    better3: 0,
    worse3to5: 0,
    other: 0
  };

  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i];
    const delta = Number(snapshot.syntheticDeltaPct);
    const lossCount = Number(snapshot.speculativeLossCount);
    if (snapshot.status === "winner") {
      winners += 1;
    } else {
      losers += 1;
    }
    if (Number.isFinite(lossCount) && lossCount > maxSpeculativeLossesObserved) {
      maxSpeculativeLossesObserved = lossCount;
    }

    if (delta >= 0.5 && delta < 1.5) {
      distribution.better1 += 1;
    } else if (delta >= 1.5 && delta < 2.5) {
      distribution.better2 += 1;
    } else if (delta >= 2.5 && delta < 3.5) {
      distribution.better3 += 1;
    } else if (delta <= -3 && delta >= -5) {
      distribution.worse3to5 += 1;
    } else {
      distribution.other += 1;
    }
  }

  return {
    total: snapshots.length,
    winners,
    losers,
    maxSpeculativeLossesObserved,
    distribution
  };
}

function percentOf(total, value) {
  if (!Number.isFinite(total) || total <= 0) {
    return "0.00%";
  }
  return `${((value / total) * 100).toFixed(2)}%`;
}

function parseArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    ...createDefaultArgs(),
    outputSvg: "",
    outputHtml: "",
    help: false
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];

    if (token.startsWith("--base-file=")) {
      const value = token.slice(token.indexOf("=") + 1);
      args.baseFile = normalizeRootBaseFileName(value, "--base-file");
      continue;
    }

    switch (token) {
      case "--base-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-file requires a value.");
        }
        args.baseFile = normalizeRootBaseFileName(value, "--base-file");
        i += 1;
        break;
      }
      case "--output-json": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--output-json requires a file path.");
        }
        args.outputJson = value;
        i += 1;
        break;
      }
      case "--output-svg": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--output-svg requires a file path.");
        }
        args.outputSvg = value;
        i += 1;
        break;
      }
      case "--output-html": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--output-html requires a file path.");
        }
        args.outputHtml = value;
        i += 1;
        break;
      }
      case "--seed": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--seed requires a numeric value.");
        }
        args.seed = toPositiveInt(value, args.seed);
        i += 1;
        break;
      }
      case "--max-root-branches": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires an integer.`);
        }
        args.maxRootBranches = toPositiveInt(value, args.maxRootBranches);
        i += 1;
        break;
      }
      case "--max-child-variants-per-winner": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires an integer.`);
        }
        args.maxChildVariantsPerWinner = toPositiveInt(value, args.maxChildVariantsPerWinner);
        i += 1;
        break;
      }
      case "--max-speculative-losses": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires an integer.`);
        }
        args.maxSpeculativeLosses = toPositiveInt(value, args.maxSpeculativeLosses);
        i += 1;
        break;
      }
      case "--win-threshold-pct": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--win-threshold-pct requires a numeric value.");
        }
        args.winThresholdPct = toNumber(value, args.winThresholdPct);
        i += 1;
        break;
      }
      case "--max-snapshots": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--max-snapshots requires an integer.");
        }
        args.maxSnapshots = toPositiveInt(value, args.maxSnapshots);
        i += 1;
        break;
      }
      case "--base-native-ms": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-native-ms requires a numeric value.");
        }
        args.baseNativeMs = toPositiveNumber(value, args.baseNativeMs);
        i += 1;
        break;
      }
      case "--base-candidate-ms": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-candidate-ms requires a numeric value.");
        }
        args.baseCandidateMs = toPositiveNumber(value, args.baseCandidateMs);
        i += 1;
        break;
      }
      case "--title": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--title requires text.");
        }
        args.title = value;
        i += 1;
        break;
      }
      case "--help":
      case "-h": {
        args.help = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (!Number.isFinite(args.winThresholdPct) || args.winThresholdPct <= 0) {
    throw new Error("--win-threshold-pct must be a positive number.");
  }

  if (!args.outputJson) {
    args.outputJson = path.join(
      evolutionDirForBase(args.baseFile, runtimeProfile),
      fakeMetadataFileName(runtimeProfile.metadataFileName)
    );
  }
  args.snapshotDir = snapshotDirForBase(args.baseFile, runtimeProfile);

  return args;
}

function replaceExtension(filePath, extension) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function ensureFakePath(filePath, fallbackExtension) {
  const parsed = path.parse(filePath);
  const extension = parsed.ext && parsed.ext !== "" ? parsed.ext : fallbackExtension;
  const baseName = parsed.name.endsWith(".fake")
    ? parsed.name
    : `${parsed.name}.fake`;
  return path.join(parsed.dir, `${baseName}${extension}`);
}

export async function runSimulationCli(argv) {
  runtimeProfile = resolveHelpSortingProfile(argv);
  const previewArgs = parseArgs(argv);
  if (previewArgs.help) {
    printHelp();
    return;
  }
  runtimeProfile = resolveActiveSortingProfile(argv);
  const args = parseArgs(argv);

  const outputJson = ensureFakePath(args.outputJson, ".json");
  const outputSvg = ensureFakePath(args.outputSvg || replaceExtension(outputJson, ".svg"), ".svg");
  const outputHtml = ensureFakePath(args.outputHtml || replaceExtension(outputJson, ".html"), ".html");

  await fs.mkdir(path.dirname(outputJson), { recursive: true });
  await fs.mkdir(path.dirname(outputSvg), { recursive: true });
  await fs.mkdir(path.dirname(outputHtml), { recursive: true });

  const state = buildSimulationState(args);
  runOrchestrator(state);

  await fs.writeFile(outputJson, JSON.stringify(state.metadata, null, 2), "utf8");

  const artifacts = buildEvolutionGraphArtifacts(state.metadata, {
    title: args.title,
    candidateLabel: runtimeProfile.candidateLabel,
    svgPath: outputSvg,
    htmlPath: outputHtml
  });
  await fs.writeFile(outputSvg, artifacts.svg, "utf8");
  await fs.writeFile(outputHtml, artifacts.html, "utf8");

  const summary = summarizeSimulation(state.metadata);
  console.log(`Synthetic metadata: ${outputJson}`);
  console.log(`Graph SVG: ${outputSvg}`);
  console.log(`Graph HTML: ${outputHtml}`);
  console.log(`Snapshots generated: ${summary.total}`);
  console.log(`Winners: ${summary.winners}, losers: ${summary.losers}`);
  console.log(
    `Limits -> root: ${args.maxRootBranches}, child: ${args.maxChildVariantsPerWinner}, speculative losses: ${args.maxSpeculativeLosses}, win threshold: ${args.winThresholdPct.toFixed(2)}%`
  );
  console.log(
    `Local beam -> width: ${ORCHESTRATOR_LOCAL_BEAM_POLICY.localBeamWidth}, max loser children: ${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxChildrenPerLoser}, ugly continuations: ${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxUglyContinuationsPerFamily}`
  );
  console.log(`Max speculative losses observed: ${summary.maxSpeculativeLossesObserved}`);
  console.log(
    `Distribution -> +1%: ${percentOf(summary.total, summary.distribution.better1)}, +2%: ${percentOf(
      summary.total,
      summary.distribution.better2
    )}, +3%: ${percentOf(summary.total, summary.distribution.better3)}, -3..-5%: ${percentOf(
      summary.total,
      summary.distribution.worse3to5
    )}, other: ${percentOf(summary.total, summary.distribution.other)}`
  );
}

function isDirectInvocation() {
  if (typeof process === "undefined" || !process.argv || process.argv.length < 2) {
    return false;
  }
  const invokedPath = path.resolve(process.argv[1]);
  const currentPath = path.resolve(fileURLToPath(import.meta.url));
  return invokedPath === currentPath;
}

if (isDirectInvocation()) {
  runSimulationCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Simulation CLI failed: ${message}`);
    process.exitCode = 1;
  });
}

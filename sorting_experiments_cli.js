import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARED_BENCHMARK_AB_TESTING,
  SHARED_BENCHMARK_DIRECTIONS,
  SHARED_BENCHMARK_ORDER_MODE,
  SHARED_BENCHMARK_STORE_RAW_RUN_VALUES,
  SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION,
} from "./shared_benchmark_session_core.js";
import {
  evolutionDirForBase,
  evolutionRootDirForProfile,
  resolveActiveSortingProfile,
  resolveFallbackSortingProfile,
  snapshotDirForBase,
} from "./sorting_profile_core.js";
import {
  normalizeBaseFileName as normalizeRootBaseFileName,
  resolveHelpSortingProfile,
  stripGlobalSortingArgs,
  toPositiveInt,
} from "./cli_arg_utils_core.js";
import {
  ORCHESTRATOR_BRANCH_LIMITS,
  ORCHESTRATOR_DECISION_THRESHOLDS,
  ORCHESTRATOR_LOCAL_BEAM_POLICY,
  createDefaultConstraints as createDefaultOrchestratorConstraints,
  createPlannerDefaults as createOrchestratorPlannerDefaults,
} from "./orchestrator_policy_core.js";
import { ROOT_SNAPSHOT_ID } from "./orchestrator_planner_core.js";
import {
  appendNonStrategicAttemptLog,
  ensureInitialized,
  fileExists,
  persistSnapshot,
  readMetadata,
  resolveSnapshotFilePath,
} from "./sorting_experiments_persistence_core.js";
import {
  buildNextWorkPlan,
  formatPlan,
  getLatestSnapshot,
  getMaxSpeculativeLosses,
  getSnapshotById,
  getSpeculativeLossCount,
  resolveAnchorSnapshotForAutoRecord,
  resolveBranchForSnapshot,
} from "./sorting_experiments_planner_core.js";
import {
  DECISION_USE_WARMUP,
  buildSnapshotRecord,
  computePresetDeltaPct,
  decideAutoStatus,
  parseAutoRecordArgs,
  parseRecordArgs,
  runBenchmarkForSnapshot,
  runConfiguredUnitTestSuite,
  runNodeSyntaxCheck,
  runSharedDecisionBenchmarkSuite,
  summarizeTestResults,
} from "./sorting_experiments_decision_core.js";
import { createReportingCore } from "./sorting_experiments_reporting_core.js";
import { createSortingExperimentCommandHandlers } from "./sorting_experiments_commands_core.js";

let runtimeProfile = resolveFallbackSortingProfile();
let WORKING_FILE = runtimeProfile.workingFile;
let CANDIDATE_LABEL = runtimeProfile.candidateLabel;
let CANDIDATE_SORTER_ID = runtimeProfile.candidateSorterId;
let CANDIDATE_LOG_TOKEN =
  String(CANDIDATE_LABEL)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "candidate";
let EVOLUTION_ROOT_DIR = evolutionRootDirForProfile(runtimeProfile);
let SNAPSHOT_PREFIX = runtimeProfile.snapshotPrefix;
let SNAPSHOT_ROOT_DIR = path.join(
  runtimeProfile.rootDir,
  runtimeProfile.snapshotDirName
);
let SNAPSHOT_DIGITS = runtimeProfile.snapshotDigits;
const ROOT_ID = ROOT_SNAPSHOT_ID;

let ACTIVE_BASE_FILE = "";
let ACTIVE_BASE_STEM = "";
let EVOLUTION_DIR = path.join(EVOLUTION_ROOT_DIR, ACTIVE_BASE_STEM);
let METADATA_FILE = path.join(EVOLUTION_DIR, runtimeProfile.metadataFileName);
let PROGRESS_LOG_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressLogFileName);
let PROGRESS_JSONL_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressJsonlFileName);
let PROGRESS_CSV_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressCsvFileName);
let SNAPSHOT_DIR = path.join(SNAPSHOT_ROOT_DIR, ACTIVE_BASE_STEM);
let reporting = createReportingCore({ candidateLogToken: CANDIDATE_LOG_TOKEN });

const DEFAULT_CONSTRAINTS = Object.freeze(createDefaultOrchestratorConstraints());

const DEFAULT_BENCHMARK_PRESET = "medium";
const AUTO_DECISION_PRESET_IDS = Object.freeze(["quick", "medium", "balanced"]);
const AUTO_DECISION_AB_TESTING = SHARED_BENCHMARK_AB_TESTING;
const AUTO_DECISION_ORDER_MODE = SHARED_BENCHMARK_ORDER_MODE;
const AUTO_DECISION_DIRECTIONS = SHARED_BENCHMARK_DIRECTIONS;
const AUTO_DECISION_WARMUP_RUNS_PER_COMBINATION = SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION;
const AUTO_DECISION_STORE_RAW_RUN_VALUES = SHARED_BENCHMARK_STORE_RAW_RUN_VALUES;
const AUTO_DECISION_USE_PARETO_MODE = false;
const AUTO_DECISION_MODE = AUTO_DECISION_USE_PARETO_MODE ? "pareto" : "overall";
const AUTO_DECISION_OVERALL_WIN_THRESHOLD_PCT =
  ORCHESTRATOR_DECISION_THRESHOLDS.overallWinThresholdPct;
const AUTO_DECISION_OVERALL_MAX_PRESET_REGRESSION_PCT =
  ORCHESTRATOR_DECISION_THRESHOLDS.overallMaxPresetRegressionPct;
const AUTO_DECISION_PARETO_TARGET_PRESET_IDS = Object.freeze(["quick", "medium", "balanced"]);
const AUTO_DECISION_PARETO_MIN_TARGET_IMPROVEMENT_PCT = 1.5;
const AUTO_DECISION_PARETO_MAX_PRESET_REGRESSION_PCT = 3;

function plannerDefaults() {
  return createOrchestratorPlannerDefaults(ROOT_ID);
}

function nowIso() {
  return new Date().toISOString();
}

function currentContext() {
  return {
    evolutionDir: EVOLUTION_DIR,
    metadataFile: METADATA_FILE,
    progressLogFile: PROGRESS_LOG_FILE,
    progressJsonlFile: PROGRESS_JSONL_FILE,
    progressCsvFile: PROGRESS_CSV_FILE,
    snapshotDir: SNAPSHOT_DIR,
    snapshotPrefix: SNAPSHOT_PREFIX,
    snapshotDigits: SNAPSHOT_DIGITS,
  };
}

function applyRuntimeProfile(profile) {
  runtimeProfile = profile;
  WORKING_FILE = runtimeProfile.workingFile;
  CANDIDATE_LABEL = runtimeProfile.candidateLabel;
  CANDIDATE_SORTER_ID = runtimeProfile.candidateSorterId;
  CANDIDATE_LOG_TOKEN =
    String(CANDIDATE_LABEL)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "candidate";
  reporting = createReportingCore({ candidateLogToken: CANDIDATE_LOG_TOKEN });
  EVOLUTION_ROOT_DIR = evolutionRootDirForProfile(runtimeProfile);
  SNAPSHOT_PREFIX = runtimeProfile.snapshotPrefix;
  SNAPSHOT_ROOT_DIR = path.join(runtimeProfile.rootDir, runtimeProfile.snapshotDirName);
  SNAPSHOT_DIGITS = runtimeProfile.snapshotDigits;

  if (ACTIVE_BASE_STEM.trim() === "") {
    EVOLUTION_DIR = path.join(EVOLUTION_ROOT_DIR, ACTIVE_BASE_STEM);
    METADATA_FILE = path.join(EVOLUTION_DIR, runtimeProfile.metadataFileName);
    PROGRESS_LOG_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressLogFileName);
    PROGRESS_JSONL_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressJsonlFileName);
    PROGRESS_CSV_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressCsvFileName);
    SNAPSHOT_DIR = path.join(SNAPSHOT_ROOT_DIR, ACTIVE_BASE_STEM);
  } else {
    EVOLUTION_DIR = evolutionDirForBase(ACTIVE_BASE_FILE, runtimeProfile);
    METADATA_FILE = path.join(EVOLUTION_DIR, runtimeProfile.metadataFileName);
    PROGRESS_LOG_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressLogFileName);
    PROGRESS_JSONL_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressJsonlFileName);
    PROGRESS_CSV_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressCsvFileName);
    SNAPSHOT_DIR = snapshotDirForBase(ACTIVE_BASE_FILE, runtimeProfile);
  }
}

function normalizeBaseFileName(value) {
  const baseName = normalizeRootBaseFileName(value, "--base-file");

  if (baseName.toLowerCase() === WORKING_FILE.toLowerCase()) {
    throw new Error(`--base-file cannot be ${WORKING_FILE}; use an immutable baseline file.`);
  }

  return baseName;
}

function baseStemFromFileName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".js")) {
    return fileName.slice(0, -3);
  }
  return fileName;
}

function configureExperimentContext(baseFileName) {
  const normalizedBaseFile = normalizeBaseFileName(baseFileName);
  const stem = baseStemFromFileName(normalizedBaseFile);
  if (stem.trim() === "") {
    throw new Error("Invalid --base-file; derived base stem is empty.");
  }

  ACTIVE_BASE_FILE = normalizedBaseFile;
  ACTIVE_BASE_STEM = stem;
  EVOLUTION_DIR = evolutionDirForBase(ACTIVE_BASE_FILE, runtimeProfile);
  METADATA_FILE = path.join(EVOLUTION_DIR, runtimeProfile.metadataFileName);
  PROGRESS_LOG_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressLogFileName);
  PROGRESS_JSONL_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressJsonlFileName);
  PROGRESS_CSV_FILE = path.join(EVOLUTION_DIR, runtimeProfile.progressCsvFileName);
  SNAPSHOT_DIR = snapshotDirForBase(ACTIVE_BASE_FILE, runtimeProfile);
}

function parseGlobalCliOptions(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  let baseFile = null;
  let hasBaseFile = false;
  const commandArgs = [];

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];

    if (token === "--base-file") {
      const value = filteredArgv[i + 1];
      if (!value) {
        throw new Error("--base-file requires a value.");
      }
      baseFile = normalizeBaseFileName(value);
      hasBaseFile = true;
      i += 1;
      continue;
    }

    if (token.startsWith("--base-file=")) {
      const value = token.slice(token.indexOf("=") + 1);
      baseFile = normalizeBaseFileName(value);
      hasBaseFile = true;
      continue;
    }

    commandArgs.push(token);
  }

  return {
    baseFile,
    hasBaseFile,
    commandArgs,
  };
}

function printHelp() {
  const displayBaseStem = ACTIVE_BASE_STEM || "<base-stem>";
  const displayEvolutionDir = path.join(EVOLUTION_ROOT_DIR, displayBaseStem);
  console.log(`${CANDIDATE_LABEL} experiment manager`);
  console.log("");
  console.log("Commands:");
  console.log("  init [--force]");
  console.log("  record --idea <text> --status <winner|loser> [--parent <id>] [--new-branch]");
  console.log("         [--benchmark-preset <id>] [--benchmark-runs <n>] [--skip-benchmark] [--skip-tests]");
  console.log("  auto-record --idea <text> [--display-preset <id>] [--benchmark-runs <n>]");
  console.log("             [--include-immediate-parent] [--skip-tests] [--parent <id>] [--new-branch]");
  console.log("  status");
  console.log("  list [--limit <n>]");
  console.log("  next");
  console.log("  prepare");
  console.log("  checkout [--id <snapshot-id>]");
  console.log("");
  console.log("Global options:");
  console.log("  --sorting <id>        Required. Select active sorting profile for this run.");
  console.log("  --base-file <name>.js  Required. Selects experiment context folder and root baseline file.");
  console.log(
    `                          Paths: ${runtimeProfile.rootDir}/${runtimeProfile.evolutionDirName}/<base-stem>/... and ${runtimeProfile.rootDir}/${runtimeProfile.snapshotDirName}/<base-stem>/...`
  );
  console.log("");
  console.log("Notes:");
  console.log("  auto-record decision benchmark suite is fixed to presets: quick, medium, balanced.");
  console.log("  Decision benchmark flow: shared preset session (native + anchor + candidate) per preset.");
  console.log(
    `  Sorter order mode: ${AUTO_DECISION_ORDER_MODE}; AB_TESTING=${AUTO_DECISION_AB_TESTING ? "on" : "off"}.`
  );
  console.log(
    `  Warmup: ${DECISION_USE_WARMUP ? "on" : "off"} (${AUTO_DECISION_WARMUP_RUNS_PER_COMBINATION} per case/direction/sorter).`
  );
  if (AUTO_DECISION_MODE === "pareto") {
    console.log(
      `  Winner metric: pareto (at least one target preset improves by >= ${AUTO_DECISION_PARETO_MIN_TARGET_IMPROVEMENT_PCT.toFixed(
        2
      )}% and no preset regresses below -${AUTO_DECISION_PARETO_MAX_PRESET_REGRESSION_PCT.toFixed(
        2
      )}%).`
    );
  } else {
    console.log(
      `  Winner metric: overall_geomean_score_p50 (overall improvement >= ${AUTO_DECISION_OVERALL_WIN_THRESHOLD_PCT.toFixed(
        2
      )}% with max preset regression ${AUTO_DECISION_OVERALL_MAX_PRESET_REGRESSION_PCT.toFixed(
        2
      )}%).`
    );
  }
  console.log(
    `  Limits: MAX_ROOT_BRANCHES=${ORCHESTRATOR_BRANCH_LIMITS.maxRootBranches}, MAX_CHILD_VARIANTS_PER_WINNER=${ORCHESTRATOR_BRANCH_LIMITS.maxChildVariantsPerWinner}, MAX_SPECULATIVE_LOSSES=${ORCHESTRATOR_BRANCH_LIMITS.maxSpeculativeLosses}.`
  );
  console.log(
    `  Local Beam DFS: LOCAL_BEAM_WIDTH=${ORCHESTRATOR_LOCAL_BEAM_POLICY.localBeamWidth}, MAX_CHILDREN_PER_LOSER=${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxChildrenPerLoser}, MAX_UGLY_CONTINUATIONS_PER_FAMILY=${ORCHESTRATOR_LOCAL_BEAM_POLICY.maxUglyContinuationsPerFamily}.`
  );
  console.log("  --display-preset in auto-record selects the preset shown in raw timing summary/log lines.");
  console.log("  --include-immediate-parent adds opt-in same-session immediate-parent telemetry; decisions still use anchor.");
  console.log("");
  console.log(`Active base file: ${ACTIVE_BASE_FILE || "n/a (pass --base-file)"}`);
  console.log(`Active base stem: ${ACTIVE_BASE_STEM || "<base-stem> (pass --base-file)"}`);
  console.log(
    `Auto-appended progress log: ${path.join(
      displayEvolutionDir,
      runtimeProfile.progressLogFileName
    )}`
  );
  console.log(
    `Auto-appended progress log: ${path.join(
      displayEvolutionDir,
      runtimeProfile.progressJsonlFileName
    )}`
  );
  console.log(
    `Auto-appended progress log: ${path.join(
      displayEvolutionDir,
      runtimeProfile.progressCsvFileName
    )}`
  );
}
function resolveCommandContext() {
  return {
    ROOT_ID,
    DEFAULT_CONSTRAINTS,
    DEFAULT_BENCHMARK_PRESET,
    AUTO_DECISION_PRESET_IDS,
    AUTO_DECISION_AB_TESTING,
    AUTO_DECISION_ORDER_MODE,
    AUTO_DECISION_DIRECTIONS,
    AUTO_DECISION_WARMUP_RUNS_PER_COMBINATION,
    AUTO_DECISION_STORE_RAW_RUN_VALUES,
    AUTO_DECISION_MODE,
    AUTO_DECISION_OVERALL_WIN_THRESHOLD_PCT,
    AUTO_DECISION_OVERALL_MAX_PRESET_REGRESSION_PCT,
    AUTO_DECISION_PARETO_TARGET_PRESET_IDS,
    AUTO_DECISION_PARETO_MIN_TARGET_IMPROVEMENT_PCT,
    AUTO_DECISION_PARETO_MAX_PRESET_REGRESSION_PCT,
    DECISION_USE_WARMUP,
    runtimeProfile,
    BASE_FILE: ACTIVE_BASE_FILE,
    WORKING_FILE,
    CANDIDATE_LABEL,
    CANDIDATE_SORTER_ID,
    reporting,
    nowIso,
    plannerDefaults,
    currentContext,
    appendNonStrategicAttemptLog,
    fileExists,
    persistSnapshot,
    readMetadata,
    resolveSnapshotFilePath,
    buildNextWorkPlan,
    formatPlan,
    getLatestSnapshot,
    getMaxSpeculativeLosses,
    getSnapshotById,
    getSpeculativeLossCount,
    resolveAnchorSnapshotForAutoRecord,
    resolveBranchForSnapshot,
    buildSnapshotRecord,
    computePresetDeltaPct,
    decideAutoStatus,
    parseAutoRecordArgs,
    parseRecordArgs,
    runBenchmarkForSnapshot,
    runConfiguredUnitTestSuite,
    runNodeSyntaxCheck,
    runSharedDecisionBenchmarkSuite,
    summarizeTestResults,
    toPositiveInt,
  };
}

const commandHandlers = createSortingExperimentCommandHandlers(resolveCommandContext);

async function runCli(argv) {
  applyRuntimeProfile(resolveHelpSortingProfile(argv));
  const previewGlobals = parseGlobalCliOptions(argv);
  const [previewCommand] = previewGlobals.commandArgs;

  if (
    !previewCommand ||
    previewCommand === "help" ||
    previewCommand === "--help" ||
    previewCommand === "-h"
  ) {
    if (previewGlobals.hasBaseFile) {
      configureExperimentContext(previewGlobals.baseFile);
    }
    printHelp();
    return;
  }

  applyRuntimeProfile(resolveActiveSortingProfile(argv));
  const parsedGlobals = parseGlobalCliOptions(argv);
  const [command, ...rest] = parsedGlobals.commandArgs;

  if (!parsedGlobals.hasBaseFile) {
    throw new Error("Missing required global option: --base-file <name>.js");
  }

  configureExperimentContext(parsedGlobals.baseFile);

  if (command === "init") {
    const force = rest.includes("--force");
    await ensureInitialized({
      force,
      context: currentContext(),
      nowIso,
      defaultConstraints: DEFAULT_CONSTRAINTS,
      rootId: ROOT_ID,
      workingFile: WORKING_FILE,
      baseFile: ACTIVE_BASE_FILE,
      candidateLabel: CANDIDATE_LABEL,
    });
    return;
  }

  if (command === "record") {
    await commandHandlers.recordSnapshot(rest);
    return;
  }

  if (command === "auto-record") {
    await commandHandlers.autoRecordSnapshot(rest);
    return;
  }

  if (command === "status") {
    await commandHandlers.printStatus();
    return;
  }

  if (command === "list") {
    await commandHandlers.listSnapshots(rest);
    return;
  }

  if (command === "checkout") {
    await commandHandlers.checkoutSnapshot(rest);
    return;
  }

  if (command === "next") {
    await commandHandlers.printNextPlan(false);
    return;
  }

  if (command === "prepare") {
    await commandHandlers.printNextPlan(true);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function isDirectInvocation() {
  if (typeof process === "undefined" || !process.versions || !process.versions.node) {
    return false;
  }

  if (!process.argv || process.argv.length < 2) {
    return false;
  }

  const cliPath = path.resolve(fileURLToPath(import.meta.url));
  const invokedPath = path.resolve(process.argv[1]);
  return cliPath === invokedPath;
}

if (isDirectInvocation()) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Experiment CLI failed: ${message}`);
    process.exitCode = 1;
  });
}

export { runCli as runSortingExperimentCli };

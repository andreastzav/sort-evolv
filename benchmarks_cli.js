import {
  BENCHMARK_PRESETS,
  DEFAULT_BENCHMARK_PRESET_IDS,
  defaultSorterIdsForProfile,
  findBenchmarkPresetById,
  formatBenchmarkReportLines,
  runSortBenchmark
} from "./benchmarks_core.js";
import { formatCount, generateRows } from "./generation_core.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  normalizeSnapshotToken,
  resolveActiveSortingProfile,
  snapshotDirForBase,
  snapshotFilePattern
} from "./sorting_profile_core.js";
import {
  parseCsvList,
  normalizeBaseFileName,
  resolveHelpSortingProfile,
  stripGlobalSortingArgs,
  toPositiveInt,
} from "./cli_arg_utils_core.js";
import { fileExists } from "./fs_utils_core.js";

const DEFAULT_RUNS_PER_CASE = 3;

function printHelp(profile) {
  console.log("benchmark cli");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node benchmarks_cli.js --sorting <id> --base-file <name>.js [--presets <ids>] [--candidate-file <file>] [options]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>          Required. Select active sorting profile for this run.");
  console.log("  --base-file <name>.js   Required. Selects snapshot context path.");
  console.log("  --presets <csv>         Preset ids (default: quick,medium).");
  console.log("  --rows <n>              Custom row count mode (overrides presets mode).");
  console.log("  --runs <n>              Measured runs per case/direction.");
  console.log("  --seed <n>              Seed override.");
  console.log(
    `  --candidate-file <path> Candidate sorter module (default: ${profile.workingFile}).`
  );
  console.log("  --sorters <csv>         Sorter ids list (default: native,candidate).");
  console.log("  --list-presets          Print available benchmark presets.");
  console.log("  --validate              Validate sorted output during benchmark.");
  console.log("  --json                  Print JSON report payload after text output.");
  console.log("  --help                  Show help.");
}

async function resolveSorterFilePath(inputPath, snapshotDir, profile, snapshotPattern) {
  const normalizedInput = normalizeSnapshotToken(inputPath, profile);
  const directPath = path.resolve(process.cwd(), normalizedInput);
  if (await fileExists(directPath)) {
    return directPath;
  }

  const baseName = path.basename(normalizedInput);
  if (baseName === normalizedInput && snapshotPattern.test(baseName)) {
    const snapshotPath = path.resolve(process.cwd(), snapshotDir, baseName);
    if (await fileExists(snapshotPath)) {
      return snapshotPath;
    }
  }

  return path.resolve(process.cwd(), normalizedInput);
}

function parseCliArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    baseFile: null,
    presetIds: [],
    rowCount: null,
    runs: null,
    seed: null,
    sorters: null,
    candidateFile: null,
    listPresets: false,
    validateSorted: false,
    json: false
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];

    switch (token) {
      case "--base-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-file requires a value.");
        }
        args.baseFile = normalizeBaseFileName(value);
        i += 1;
        break;
      }
      case "--presets": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--presets requires a comma-separated value.");
        }
        args.presetIds.push(...parseCsvList(value));
        i += 1;
        break;
      }
      case "--rows": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--rows requires a value.");
        }
        args.rowCount = toPositiveInt(value, 0);
        if (args.rowCount <= 0) {
          throw new Error("--rows must be a positive integer.");
        }
        i += 1;
        break;
      }
      case "--runs": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--runs requires a value.");
        }
        args.runs = toPositiveInt(value, 0);
        if (args.runs <= 0) {
          throw new Error("--runs must be a positive integer.");
        }
        i += 1;
        break;
      }
      case "--seed": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--seed requires a value.");
        }
        args.seed = Number(value);
        if (!Number.isFinite(args.seed)) {
          throw new Error("--seed must be numeric.");
        }
        i += 1;
        break;
      }
      case "--sorters": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--sorters requires a comma-separated value.");
        }
        args.sorters = parseCsvList(value);
        i += 1;
        break;
      }
      case "--candidate-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires a value.`);
        }
        args.candidateFile = value;
        i += 1;
        break;
      }
      case "--list-presets": {
        args.listPresets = true;
        break;
      }
      case "--validate": {
        args.validateSorted = true;
        break;
      }
      case "--json": {
        args.json = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  return args;
}

async function loadCandidateSorterFromFile(candidateFile, snapshotDir, profile, snapshotPattern) {
  if (!candidateFile) {
    return null;
  }

  const resolvedPath = await resolveSorterFilePath(
    candidateFile,
    snapshotDir,
    profile,
    snapshotPattern
  );
  const moduleUrl = pathToFileURL(resolvedPath).href;
  let loadedModule;

  try {
    loadedModule = await import(moduleUrl);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Failed to import --candidate-file (${resolvedPath}): ${message}`);
  }

  const sortFn = loadedModule && typeof loadedModule.default === "function" ? loadedModule.default : null;
  if (!sortFn) {
    throw new Error(`--candidate-file must export a default sorting function: ${resolvedPath}`);
  }

  return Object.freeze({
    id: profile.candidateSorterId,
    label: path.basename(resolvedPath),
    sortInPlace(array, compareFn) {
      return sortFn(array, compareFn);
    }
  });
}

function resolveSortersForRun(sorters, customCandidateSorter, profile) {
  const base =
    Array.isArray(sorters) && sorters.length > 0
      ? sorters.slice()
      : defaultSorterIdsForProfile(profile);
  if (!customCandidateSorter) {
    return base;
  }

  const resolved = new Array(base.length);
  for (let i = 0; i < base.length; i += 1) {
    const token = String(base[i] || "").trim();
    resolved[i] = token === profile.candidateSorterId ? customCandidateSorter : base[i];
  }
  return resolved;
}

function printPresetList() {
  console.log("Available benchmark presets:");
  for (let i = 0; i < BENCHMARK_PRESETS.length; i += 1) {
    const preset = BENCHMARK_PRESETS[i];
    console.log(
      `- ${preset.id}: ${preset.label} | rows=${formatCount(preset.rowCount)}, runs=${preset.runs}, seed=${preset.seed}`
    );
  }
}

export async function runBenchmarkCli(argv = []) {
  if (Array.isArray(argv) && (argv.includes("--help") || argv.includes("-h"))) {
    printHelp(resolveHelpSortingProfile(argv));
    return [];
  }
  const profile = resolveActiveSortingProfile(argv);

  const args = parseCliArgs(argv);

  if (args.listPresets) {
    printPresetList();
    return [];
  }

  if (!args.baseFile) {
    throw new Error("Missing required option: --base-file <name>.js");
  }

  const snapshotPattern = snapshotFilePattern(profile);
  const snapshotDir = snapshotDirForBase(args.baseFile, profile);
  const requestedSorters =
    Array.isArray(args.sorters) && args.sorters.length > 0
      ? args.sorters.slice()
      : defaultSorterIdsForProfile(profile);
  const needsCandidateSorter = requestedSorters.some((entry) => {
    if (typeof entry !== "string") {
      return false;
    }
    return entry.trim() === profile.candidateSorterId;
  });

  const customCandidateSorter = needsCandidateSorter
    ? await loadCandidateSorterFromFile(
        args.candidateFile || profile.workingFile,
        snapshotDir,
        profile,
        snapshotPattern
      )
    : null;
  const selectedSorters = resolveSortersForRun(
    requestedSorters,
    customCandidateSorter,
    profile
  );
  const outputs = [];

  if (args.rowCount !== null) {
    const customLabel = `Custom ${formatCount(args.rowCount)} rows`;
    const customSeed = args.seed !== null ? args.seed : 20260325;
    const customRuns = args.runs !== null ? args.runs : DEFAULT_RUNS_PER_CASE;
    const rows = generateRows(args.rowCount, { seed: customSeed });
    const report = runSortBenchmark(rows, {
      runs: customRuns,
      sorters: selectedSorters,
      profile,
      candidateSorter: customCandidateSorter,
      validateSorted: args.validateSorted
    });
    const lines = formatBenchmarkReportLines(report, {
      datasetLabel: customLabel,
      candidateLabel: profile.candidateLabel
    });
    outputs.push({
      label: customLabel,
      rows,
      report,
      lines
    });
  } else {
    const presetIds =
      args.presetIds.length > 0 ? args.presetIds : DEFAULT_BENCHMARK_PRESET_IDS.slice();

    for (let i = 0; i < presetIds.length; i += 1) {
      const preset = findBenchmarkPresetById(presetIds[i]);
      if (!preset) {
        throw new Error(`Unknown preset id: ${presetIds[i]}`);
      }

      const rows = generateRows(preset.rowCount, {
        seed: args.seed !== null ? args.seed : preset.seed
      });
      const report = runSortBenchmark(rows, {
        runs: args.runs !== null ? args.runs : preset.runs,
        sorters: selectedSorters,
        profile,
        candidateSorter: customCandidateSorter,
        validateSorted: args.validateSorted
      });
      const lines = formatBenchmarkReportLines(report, {
        datasetLabel: preset.label,
        candidateLabel: profile.candidateLabel
      });

      outputs.push({
        label: preset.label,
        rows,
        report,
        lines
      });
    }
  }

  for (let i = 0; i < outputs.length; i += 1) {
    if (i > 0) {
      console.log("");
      console.log("=".repeat(80));
      console.log("");
    }

    console.log(outputs[i].lines.join("\n"));
  }

  if (args.json) {
    const reports = outputs.map((entry) => ({
      label: entry.label,
      report: entry.report
    }));
    console.log("");
    console.log(JSON.stringify(reports, null, 2));
  }

  return outputs;
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
  try {
    await runBenchmarkCli(process.argv.slice(2));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`Benchmark CLI failed: ${message}`);
    process.exitCode = 1;
  }
}


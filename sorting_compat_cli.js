import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveActiveSortingProfile } from "./sorting_profile_core.js";
import { stripGlobalSortingArgs } from "./cli_arg_utils_core.js";
import {
  loadSortFunctionFromFile,
  runBenchmarkForSnapshot,
  runConfiguredUnitTestSuite,
  summarizeTestResults,
} from "./sorting_experiments_decision_core.js";

function printHelp() {
  console.log("sorting compatibility smoke check");
  console.log("");
  console.log("Usage:");
  console.log("  node sorting_compat_cli.js --sorting <id> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --runs <n>          Benchmark runs for quick preset (default: 1).");
  console.log("  --skip-tests        Skip unit test runner.");
  console.log("  --skip-benchmark    Skip quick preset benchmark.");
  console.log("  --help              Show help.");
}

function parseArgs(argv) {
  const args = {
    runs: 1,
    skipTests: false,
    skipBenchmark: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--skip-tests") {
      args.skipTests = true;
      continue;
    }
    if (token === "--skip-benchmark") {
      args.skipBenchmark = true;
      continue;
    }
    if (token === "--runs") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--runs requires a value.");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--runs must be a positive integer.");
      }
      args.runs = parsed;
      i += 1;
      continue;
    }
    if (token.startsWith("--runs=")) {
      const value = token.slice("--runs=".length);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--runs must be a positive integer.");
      }
      args.runs = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

async function runCompat(argv) {
  const args = parseArgs(stripGlobalSortingArgs(argv));
  if (args.help) {
    printHelp();
    return;
  }

  const profile = resolveActiveSortingProfile(argv);
  const workingPath = path.resolve(profile.workingFile);
  console.log(`Sorting profile: ${profile.sortingId}`);
  console.log(`Working file: ${workingPath}`);

  console.log("1) Import candidate sorter");
  const sortFn = await loadSortFunctionFromFile(profile.workingFile);
  console.log(`   imported default export: ${typeof sortFn}`);

  if (!args.skipTests) {
    console.log("2) Run unit tests");
    const testResult = await runConfiguredUnitTestSuite(profile);
    const summary = summarizeTestResults(testResult);
    console.log(
      `   tests: ${summary.passed}/${summary.total} passed, ${summary.failed} failed (${summary.totalMs.toFixed(
        2
      )} ms)`
    );
    if (summary.failed > 0) {
      throw new Error("Unit test smoke check failed.");
    }
  } else {
    console.log("2) Unit tests skipped");
  }

  if (!args.skipBenchmark) {
    console.log("3) Run quick preset benchmark");
    const benchmark = await runBenchmarkForSnapshot(
      {
        benchmarkPreset: "quick",
        benchmarkRuns: args.runs,
      },
      {
        runtimeProfile: profile,
        candidateLabel: profile.candidateLabel,
        candidateSorterId: profile.candidateSorterId,
        workingFile: profile.workingFile,
      }
    );

    if (!benchmark) {
      throw new Error("Benchmark smoke check failed: missing totals.");
    }
    const nativeAvg = Number(benchmark.baseline?.avgMs);
    const candidateAvg = Number(benchmark.candidate?.avgMs);
    const improvement = Number(benchmark.improvementVsNativePct);
    console.log(
      `   quick totals: native avg ${nativeAvg.toFixed(2)} ms, ${profile.candidateLabel} avg ${candidateAvg.toFixed(
        2
      )} ms, improvement ${improvement.toFixed(2)}%`
    );
  } else {
    console.log("3) Benchmark skipped");
  }

  console.log("Compatibility smoke check passed.");
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
  runCompat(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Sorting compat CLI failed: ${message}`);
    process.exitCode = 1;
  });
}

export { runCompat as runSortingCompatCli };

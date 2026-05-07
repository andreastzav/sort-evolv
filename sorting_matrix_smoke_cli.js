import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveSortingProfile } from "./sorting_profile_core.js";
import {
  runBenchmarkForSnapshot,
  runConfiguredUnitTestSuite,
  summarizeTestResults,
} from "./sorting_experiments_decision_core.js";

function printHelp() {
  console.log("sorting matrix smoke check");
  console.log("");
  console.log("Usage:");
  console.log("  node sorting_matrix_smoke_cli.js --sortings <id1,id2,...> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --sortings <csv>    Required. Sorting ids to test.");
  console.log("  --runs <n>          Quick benchmark runs per sorter (default: 1).");
  console.log("  --help              Show help.");
}

function parseArgs(argv) {
  const args = {
    sortings: [],
    runs: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--sortings") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--sortings requires a value.");
      }
      args.sortings = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      i += 1;
      continue;
    }

    if (token.startsWith("--sortings=")) {
      const value = token.slice("--sortings=".length);
      args.sortings = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
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

  if (!args.help && args.sortings.length === 0) {
    throw new Error("Missing required option: --sortings <id1,id2,...>.");
  }

  return args;
}

function printSummary(rows) {
  console.log("");
  console.log("Summary:");
  console.log("sorting | tests | native_avg_ms | candidate_avg_ms | improvement_pct");
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const tests = row.tests
      ? `${row.tests.passed}/${row.tests.total}`
      : "n/a";
    const nativeAvg = Number.isFinite(row.nativeAvgMs) ? row.nativeAvgMs.toFixed(2) : "n/a";
    const candidateAvg = Number.isFinite(row.candidateAvgMs) ? row.candidateAvgMs.toFixed(2) : "n/a";
    const improvement = Number.isFinite(row.improvementPct) ? row.improvementPct.toFixed(2) : "n/a";
    console.log(`${row.sortingId} | ${tests} | ${nativeAvg} | ${candidateAvg} | ${improvement}`);
  }
}

async function runMatrix(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const summaryRows = [];
  for (let i = 0; i < args.sortings.length; i += 1) {
    const sortingId = args.sortings[i];
    const profile = resolveSortingProfile({ sortingId });
    console.log(`\n[${i + 1}/${args.sortings.length}] ${sortingId}`);

    const unitResultRaw = await runConfiguredUnitTestSuite(profile);
    const unitSummary = summarizeTestResults(unitResultRaw);
    console.log(
      `  tests: ${unitSummary.passed}/${unitSummary.total} passed, ${unitSummary.failed} failed (${unitSummary.totalMs.toFixed(
        2
      )} ms)`
    );
    if (unitSummary.failed > 0) {
      summaryRows.push({
        sortingId,
        tests: unitSummary,
        nativeAvgMs: Number.NaN,
        candidateAvgMs: Number.NaN,
        improvementPct: Number.NaN,
      });
      printSummary(summaryRows);
      throw new Error(`Unit tests failed for sorting "${sortingId}".`);
    }

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
      summaryRows.push({
        sortingId,
        tests: unitSummary,
        nativeAvgMs: Number.NaN,
        candidateAvgMs: Number.NaN,
        improvementPct: Number.NaN,
      });
      printSummary(summaryRows);
      throw new Error(`Benchmark failed for sorting "${sortingId}".`);
    }

    const nativeAvgMs = Number(benchmark.baseline?.avgMs);
    const candidateAvgMs = Number(benchmark.candidate?.avgMs);
    const improvementPct = Number(benchmark.improvementVsNativePct);
    console.log(
      `  benchmark quick: native ${nativeAvgMs.toFixed(2)} ms, ${profile.candidateLabel} ${candidateAvgMs.toFixed(
        2
      )} ms, improvement ${improvementPct.toFixed(2)}%`
    );

    summaryRows.push({
      sortingId,
      tests: unitSummary,
      nativeAvgMs,
      candidateAvgMs,
      improvementPct,
    });
  }

  printSummary(summaryRows);
  console.log("\nMatrix smoke check passed.");
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
  runMatrix(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Sorting matrix smoke failed: ${message}`);
    process.exitCode = 1;
  });
}

export { runMatrix as runSortingMatrixSmokeCli };

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveActiveSortingProfile } from "./sorting_profile_core.js";

function printHelp() {
  console.log("unit tests cli");
  console.log("");
  console.log("Usage:");
  console.log("  node unit_tests_cli.js --sorting <id>");
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>  Required. Select active sorting profile for this run.");
  console.log("  --help          Show help.");
}

export async function runUnitTestsCli(argv = []) {
  if (Array.isArray(argv) && (argv.includes("--help") || argv.includes("-h"))) {
    printHelp();
    return null;
  }

  const profile = resolveActiveSortingProfile(argv);
  const { runUnitTestSuite } = await import("./unit-tests-core.js");
  const summary = await runUnitTestSuite({
    profile,
    onResult(result) {
      if (result.status === "pass") {
        console.log(`PASS ${result.name} (${result.durationMs.toFixed(2)} ms)`);
        return;
      }

      console.error(`FAIL ${result.name} (${result.durationMs.toFixed(2)} ms)`);
      console.error(`  ${result.errorMessage}`);
    },
  });

  if (summary.failed > 0) {
    console.error(
      `Unit tests failed: ${summary.failed}/${summary.total} failed in ${summary.totalMs.toFixed(2)} ms.`
    );
  } else {
    console.log(
      `All unit tests passed (${summary.passed}/${summary.total}) in ${summary.totalMs.toFixed(2)} ms.`
    );
  }

  return summary;
}

function isDirectInvocation() {
  if (typeof process === "undefined" || !Array.isArray(process.argv) || process.argv.length < 2) {
    return false;
  }
  const invokedPath = path.resolve(process.argv[1]);
  const currentPath = path.resolve(fileURLToPath(import.meta.url));
  return invokedPath === currentPath;
}

if (isDirectInvocation()) {
  try {
    const summary = await runUnitTestsCli(process.argv.slice(2));
    if (summary && Number(summary.failed) > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`Unit tests CLI failed: ${message}`);
    process.exitCode = 1;
  }
}

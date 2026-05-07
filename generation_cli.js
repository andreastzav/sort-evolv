import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATION_PRESETS,
  findGenerationPresetById,
  formatCount,
  generateRows,
} from "./generation_core.js";
import { stripGlobalSortingArgs, toPositiveInt } from "./cli_arg_utils_core.js";
import { resolveActiveSortingId } from "./sorting_profile_core.js";

const DEFAULT_PRESET_ID = "quick-10k";

function printHelp() {
  console.log("generation cli");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node generation_cli.js --sorting <id> [--preset <id> | --rows <n>] [options]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>     Required. Select active sorting profile for this run.");
  console.log(`  --preset <id>      Generation preset id (default: ${DEFAULT_PRESET_ID}).`);
  console.log("  --rows <n>         Custom row count (overrides preset).");
  console.log("  --seed <n>         Random seed override.");
  console.log("  --start-index <n>  Starting index value for generated rows.");
  console.log("  --sample <n>       Print first n rows (default: 3, 0 disables sample).");
  console.log("  --out <file>       Save generated rows as JSON.");
  console.log("  --pretty           Pretty-print JSON output when used with --out.");
  console.log("  --list-presets     Print available generation presets.");
  console.log("  --help             Show help.");
}

function parseCliArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    presetId: null,
    rowCount: null,
    seed: null,
    outPath: null,
    startIndex: 1,
    sample: 3,
    pretty: false,
    listPresets: false,
    help: false,
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];

    switch (token) {
      case "--preset": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--preset requires a value.");
        }

        args.presetId = value;
        i += 1;
        break;
      }
      case "--rows": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--rows requires a value.");
        }

        const parsed = toPositiveInt(value, 0);
        if (parsed <= 0) {
          throw new Error("--rows must be a positive integer.");
        }

        args.rowCount = parsed;
        i += 1;
        break;
      }
      case "--seed": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--seed requires a value.");
        }

        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new Error("--seed must be numeric.");
        }

        args.seed = parsed;
        i += 1;
        break;
      }
      case "--start-index": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--start-index requires a value.");
        }

        const parsed = toPositiveInt(value, 0);
        if (parsed <= 0) {
          throw new Error("--start-index must be a positive integer.");
        }

        args.startIndex = parsed;
        i += 1;
        break;
      }
      case "--out": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out requires a file path.");
        }

        args.outPath = value;
        i += 1;
        break;
      }
      case "--sample": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--sample requires a value.");
        }

        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error("--sample must be zero or a positive integer.");
        }

        args.sample = parsed;
        i += 1;
        break;
      }
      case "--pretty": {
        args.pretty = true;
        break;
      }
      case "--list-presets": {
        args.listPresets = true;
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

  return args;
}

function printPresetList() {
  console.log("Available generation presets:");
  for (let i = 0; i < GENERATION_PRESETS.length; i += 1) {
    const preset = GENERATION_PRESETS[i];
    console.log(
      `- ${preset.id}: ${preset.label} | rows=${formatCount(preset.rowCount)}, seed=${preset.seed}`
    );
  }
}

function resolveGenerationConfig(args) {
  if (args.rowCount !== null) {
    return {
      label: `Custom ${formatCount(args.rowCount)} rows`,
      rowCount: args.rowCount,
      seed: args.seed !== null ? args.seed : Date.now() & 0xffffffff,
    };
  }

  const requestedPresetId = args.presetId || DEFAULT_PRESET_ID;
  const preset = findGenerationPresetById(requestedPresetId);
  if (!preset) {
    throw new Error(`Unknown generation preset: ${requestedPresetId}`);
  }

  return {
    label: preset.label,
    rowCount: preset.rowCount,
    seed: args.seed !== null ? args.seed : preset.seed,
  };
}

async function writeRowsToFile(filePath, rows, pretty) {
  const outputPath = path.resolve(filePath);
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });

  const json = JSON.stringify(rows, null, pretty ? 2 : 0);
  await fs.writeFile(outputPath, json, "utf8");
  return {
    outputPath,
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

export async function runGenerationCli(argv = []) {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return null;
  }
  resolveActiveSortingId(argv);

  if (args.listPresets) {
    printPresetList();
    return null;
  }

  const config = resolveGenerationConfig(args);
  const startedAt = Date.now();
  const rows = generateRows(config.rowCount, {
    seed: config.seed,
    startIndex: args.startIndex,
    totalRowCount: config.rowCount,
  });
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `Generated ${formatCount(rows.length)} rows for ${config.label} in ${elapsedMs.toLocaleString("en-US")} ms (seed ${config.seed}, startIndex ${args.startIndex}).`
  );

  if (args.outPath) {
    const fileResult = await writeRowsToFile(args.outPath, rows, args.pretty);
    console.log(
      `Saved JSON dataset to ${fileResult.outputPath} (${formatCount(fileResult.bytes)} bytes).`
    );
    return {
      rows,
      outputPath: fileResult.outputPath,
    };
  }

  if (args.sample > 0) {
    const sampleRows = rows.slice(0, Math.min(rows.length, args.sample));
    console.log(`Sample (${sampleRows.length} row${sampleRows.length === 1 ? "" : "s"}):`);
    console.log(JSON.stringify(sampleRows, null, 2));
  }

  return {
    rows,
    outputPath: null,
  };
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
  runGenerationCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Generation CLI failed: ${message}`);
    process.exitCode = 1;
  });
}


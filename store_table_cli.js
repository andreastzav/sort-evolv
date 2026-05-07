import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATION_PRESETS,
  findGenerationPresetById,
  formatCount,
  generateRows,
} from "./generation_core.js";
import {
  createBinaryTableFileName,
  decodeTableBinary,
  encodeRowsToBinary,
  formatByteCount,
} from "./store_table_core.js";
import {
  resolveActiveSortingProfile,
  tablesRootDirForProfile
} from "./sorting_profile_core.js";
import {
  resolveHelpSortingProfile,
  stripGlobalSortingArgs,
  toPositiveInt
} from "./cli_arg_utils_core.js";

const DEFAULT_PRESET_ID = "quick-10k";

function printHelp(profile) {
  const tablesRoot = tablesRootDirForProfile(profile);
  console.log("store table cli");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node store_table_cli.js --sorting <id> [--input <rows.json> | (--preset <id> | --rows <n>)] [options]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>     Required. Select active sorting profile for this run.");
  console.log(`  --preset <id>      Generation preset id (default: ${DEFAULT_PRESET_ID}).`);
  console.log("  --rows <n>         Custom row count (overrides preset).");
  console.log("  --seed <n>         Random seed override for generated rows.");
  console.log("  --start-index <n>  Starting index for generated rows.");
  console.log("  --input <file>     Read source rows from JSON file.");
  console.log(`  --out <file>       Output binary file path (default: ${tablesRoot}/table-<rows>.bin).`);
  console.log("  --no-verify        Skip binary roundtrip verification.");
  console.log("  --list-presets     Print available generation presets.");
  console.log("  --help             Show help.");
}

function normalizeDateString(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "1970-01-01";
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function parseCliArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    presetId: null,
    rowCount: null,
    seed: null,
    startIndex: 1,
    inputJsonPath: null,
    outPath: null,
    listPresets: false,
    verify: true,
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
      case "--input": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--input requires a JSON file path.");
        }

        args.inputJsonPath = value;
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
      case "--list-presets": {
        args.listPresets = true;
        break;
      }
      case "--no-verify": {
        args.verify = false;
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
      rowCount: args.rowCount,
      seed: args.seed !== null ? args.seed : Date.now() & 0xffffffff,
      label: `Custom ${formatCount(args.rowCount)} rows`,
    };
  }

  const presetId = args.presetId || DEFAULT_PRESET_ID;
  const preset = findGenerationPresetById(presetId);
  if (!preset) {
    throw new Error(`Unknown generation preset: ${presetId}`);
  }

  return {
    rowCount: preset.rowCount,
    seed: args.seed !== null ? args.seed : preset.seed,
    label: preset.label,
  };
}

async function loadRowsFromJsonFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("Input JSON must be an array of rows.");
  }

  return {
    rows: parsed,
    sourcePath: absolutePath,
  };
}

function rowsMatchByIndexes(sourceRows, decodedRows, indexes) {
  for (let i = 0; i < indexes.length; i += 1) {
    const index = indexes[i];
    const source = sourceRows[index] || {};
    const decoded = decodedRows[index] || {};

    const fields = [
      ["index", Number(source.index), Number(decoded.index)],
      ["firstName", String(source.firstName ?? ""), String(decoded.firstName ?? "")],
      ["lastName", String(source.lastName ?? ""), String(decoded.lastName ?? "")],
      ["age", Number(source.age ?? 0), Number(decoded.age ?? 0)],
      ["city", String(source.city ?? ""), String(decoded.city ?? "")],
      ["date", normalizeDateString(source.date), normalizeDateString(decoded.date)],
      ["segment", String(source.segment ?? ""), String(decoded.segment ?? "")],
      ["cohort", Number(source.cohort ?? 0), Number(decoded.cohort ?? 0)],
      ["randomA", Number(source.randomA ?? 0), Number(decoded.randomA ?? 0)],
      ["randomB", Number(source.randomB ?? 0), Number(decoded.randomB ?? 0)],
    ];

    for (let j = 0; j < fields.length; j += 1) {
      const [key, left, right] = fields[j];
      if (left !== right) {
        throw new Error(
          `Verification mismatch at row ${index}, field ${key}: ${left} !== ${right}`
        );
      }
    }
  }
}

function buildVerificationIndexes(rowCount) {
  if (rowCount <= 0) {
    return [];
  }

  if (rowCount <= 2048) {
    const all = new Array(rowCount);
    for (let i = 0; i < rowCount; i += 1) {
      all[i] = i;
    }

    return all;
  }

  const indexes = [];
  const seen = new Set();

  function add(index) {
    if (index < 0 || index >= rowCount || seen.has(index)) {
      return;
    }

    seen.add(index);
    indexes.push(index);
  }

  for (let i = 0; i < 128; i += 1) {
    add(i);
  }

  for (let i = rowCount - 128; i < rowCount; i += 1) {
    add(i);
  }

  let state = (rowCount ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < 256; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    add(state % rowCount);
  }

  return indexes;
}

async function writeBinaryFile(filePath, bytes) {
  const absolutePath = path.resolve(filePath);
  const outputDir = path.dirname(absolutePath);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(absolutePath, bytes);
  return absolutePath;
}

export async function runStoreTableCli(argv = []) {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp(resolveHelpSortingProfile(argv));
    return null;
  }
  const profile = resolveActiveSortingProfile(argv);

  if (args.listPresets) {
    printPresetList();
    return null;
  }

  if (args.inputJsonPath && (args.rowCount !== null || args.presetId !== null)) {
    throw new Error("Use either --input or generation args (--rows/--preset), not both.");
  }

  let rows = null;
  let datasetLabel = "";

  if (args.inputJsonPath) {
    const loaded = await loadRowsFromJsonFile(args.inputJsonPath);
    rows = loaded.rows;
    datasetLabel = `JSON input ${loaded.sourcePath}`;
  } else {
    const generationConfig = resolveGenerationConfig(args);
    rows = generateRows(generationConfig.rowCount, {
      seed: generationConfig.seed,
      startIndex: args.startIndex,
      totalRowCount: generationConfig.rowCount,
    });
    datasetLabel = generationConfig.label;
    console.log(
      `Generated ${formatCount(rows.length)} rows (${datasetLabel}) with seed ${generationConfig.seed}.`
    );
  }

  const encodeStart = Date.now();
  const binaryBytes = encodeRowsToBinary(rows);
  const encodeElapsedMs = Date.now() - encodeStart;
  const outputFileName =
    args.outPath ||
    path.join(
      tablesRootDirForProfile(profile),
      createBinaryTableFileName(rows.length, { prefix: "table" })
    );
  const outputPath = await writeBinaryFile(outputFileName, binaryBytes);

  console.log(
    `Saved ${formatCount(rows.length)} rows from ${datasetLabel} to ${outputPath} (${formatByteCount(
      binaryBytes.byteLength
    )}) in ${encodeElapsedMs.toLocaleString("en-US")} ms.`
  );

  if (args.verify) {
    const verifyStart = Date.now();
    const decoded = decodeTableBinary(binaryBytes);
    if (decoded.rowCount !== rows.length) {
      throw new Error(
        `Verification row count mismatch: ${decoded.rowCount} !== ${rows.length}`
      );
    }

    const indexes = buildVerificationIndexes(rows.length);
    rowsMatchByIndexes(rows, decoded.rows, indexes);
    const verifyElapsedMs = Date.now() - verifyStart;
    console.log(
      `Verified binary roundtrip on ${formatCount(indexes.length)} sampled rows in ${verifyElapsedMs.toLocaleString(
        "en-US"
      )} ms.`
    );
  }

  return {
    rows,
    outputPath,
    byteLength: binaryBytes.byteLength,
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
  runStoreTableCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Store table CLI failed: ${message}`);
    process.exitCode = 1;
  });
}

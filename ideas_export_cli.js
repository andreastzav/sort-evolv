import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evolutionDirForBase,
  resolveActiveSortingProfile,
  resolveFallbackSortingProfile
} from "./sorting_profile_core.js";
import {
  normalizeBaseFileName,
  resolveHelpSortingProfile,
  stripGlobalSortingArgs
} from "./cli_arg_utils_core.js";

const DEFAULT_OUTPUT_ONLY_FILE_NAME = "ideas_only.txt";
const DEFAULT_OUTPUT_CONTEXT_FILE_NAME = "ideas_with_context.txt";
const DEFAULT_OUTPUT_CONTEXT_JSON_FILE_NAME = "ideas_with_context.json";

function defaultInputFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    profile.progressJsonlFileName
  );
}

function defaultOutputOnlyFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    DEFAULT_OUTPUT_ONLY_FILE_NAME
  );
}

function defaultOutputContextFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    DEFAULT_OUTPUT_CONTEXT_FILE_NAME
  );
}

function defaultOutputContextJsonFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    DEFAULT_OUTPUT_CONTEXT_JSON_FILE_NAME
  );
}

function printHelp(profile) {
  const evolutionRoot = `${profile.rootDir}/${profile.evolutionDirName}`;
  console.log(`Export idea lines from ${profile.progressJsonlFileName}.`);
  console.log("");
  console.log("Usage:");
  console.log("  node ideas_export_cli.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>          Required. Select active sorting profile for this run.");
  console.log(`  --base-file <name>.js   Required. Selects ${evolutionRoot}/<base-stem>/... paths.`);
  console.log(
    `  --input <file>          Input JSONL file (default: ${evolutionRoot}/<base-stem>/${profile.progressJsonlFileName})`
  );
  console.log("  --out-only <file>       Output file for: snapshot_id | idea");
  console.log(
    "  --out-context <file>    Output TXT file for: snapshot/parent/branch/depth/status/delta_vs_anchor_overall_score_p50/idea"
  );
  console.log(
    "  --out-context-json <file> Output JSON file using the same context field names as TXT."
  );
  console.log("  --help                  Show help");
}

function parseArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    baseFile: null,
    input: null,
    outOnly: null,
    outContext: null,
    outContextJson: null,
    help: false
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];
    if (token.startsWith("--base-file=")) {
      const value = token.slice(token.indexOf("=") + 1);
      args.baseFile = normalizeBaseFileName(value);
      continue;
    }
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
      case "--input": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--input requires a file path.");
        }
        args.input = value;
        i += 1;
        break;
      }
      case "--out-only": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out-only requires a file path.");
        }
        args.outOnly = value;
        i += 1;
        break;
      }
      case "--out-context": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out-context requires a file path.");
        }
        args.outContext = value;
        i += 1;
        break;
      }
      case "--out-context-json": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out-context-json requires a file path.");
        }
        args.outContextJson = value;
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

  if (!args.help && !args.baseFile) {
    throw new Error("Missing required option: --base-file <name>.js");
  }

  return args;
}

function asText(value, fallback) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

function getRecordValue(record, preferred, fallbackValue) {
  if (Object.prototype.hasOwnProperty.call(record, preferred)) {
    return asText(record[preferred], fallbackValue);
  }
  return fallbackValue;
}

export async function runIdeasExportCli(argv) {
  const helpProfile = resolveHelpSortingProfile(argv);
  const args = parseArgs(argv);
  if (args.help) {
    printHelp(helpProfile);
    return;
  }
  const profile = resolveActiveSortingProfile(argv);
  args.input = args.input || defaultInputFileForBase(args.baseFile, profile);
  args.outOnly = args.outOnly || defaultOutputOnlyFileForBase(args.baseFile, profile);
  args.outContext = args.outContext || defaultOutputContextFileForBase(args.baseFile, profile);
  args.outContextJson =
    args.outContextJson || defaultOutputContextJsonFileForBase(args.baseFile, profile);

  const inputText = await fs.readFile(args.input, "utf8");
  const lines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const ideasOnly = [];
  const ideasWithContext = [];
  const contextRecords = [];

  for (let i = 0; i < lines.length; i += 1) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new Error(`Invalid JSONL entry at line ${i + 1}: ${message}`);
    }

    const snapshot = getRecordValue(record, "snapshot_id", "unknown");
    const idea = getRecordValue(record, "idea", "");
    const parent = getRecordValue(record, "parent", "unknown");
    const branch = getRecordValue(record, "branch", "unknown");
    const depth = getRecordValue(record, "depth", "unknown");
    const status = getRecordValue(record, "status", "unknown");
    const deltaVsAnchorOverallScoreP50 = getRecordValue(
      record,
      "delta_vs_anchor_overall_score_p50",
      "n/a"
    );

    const contextRecord = {
      snapshot,
      parent,
      branch,
      depth,
      idea,
      status,
      delta_vs_anchor_overall_score_p50: deltaVsAnchorOverallScoreP50
    };

    ideasOnly.push(`${snapshot} | ${idea}`);
    ideasWithContext.push(
      `snapshot=${contextRecord.snapshot} | parent=${contextRecord.parent} | branch=${contextRecord.branch} | depth=${contextRecord.depth} | idea=${contextRecord.idea} | status=${contextRecord.status} | delta_vs_anchor_overall_score_p50=${contextRecord.delta_vs_anchor_overall_score_p50}`
    );
    contextRecords.push(contextRecord);
  }

  await fs.mkdir(path.dirname(args.outOnly), { recursive: true });
  await fs.mkdir(path.dirname(args.outContext), { recursive: true });
  await fs.mkdir(path.dirname(args.outContextJson), { recursive: true });

  const onlyText = ideasOnly.join("\n");
  const contextText = ideasWithContext.join("\n");

  await fs.writeFile(args.outOnly, onlyText, "utf8");
  await fs.writeFile(args.outContext, contextText, "utf8");
  await fs.writeFile(args.outContextJson, `${JSON.stringify(contextRecords, null, 2)}\n`, "utf8");

  console.log(`Input: ${args.input}`);
  console.log(`Ideas exported: ${ideasOnly.length}`);
  console.log(`ideas_only: ${args.outOnly}`);
  console.log(`ideas_with_context: ${args.outContext}`);
  console.log(`ideas_with_context_json: ${args.outContextJson}`);
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
  runIdeasExportCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`ideas export failed: ${message}`);
    process.exitCode = 1;
  });
}

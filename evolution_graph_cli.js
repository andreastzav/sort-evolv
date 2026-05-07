import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildEvolutionGraphArtifacts } from "./evolution_graph_core.js";
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
import { fileExists } from "./fs_utils_core.js";

function fakeMetadataFileName(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".json")) {
    return `${fileName.slice(0, -5)}.fake.json`;
  }
  return `${fileName}.fake.json`;
}

function printHelp(profile) {
  const evolutionRoot = `${profile.rootDir}/${profile.evolutionDirName}`;
  const defaultBaseFile = `${profile.sortingId}_base_0120.js`;
  console.log("evolution graph renderer");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node evolution_graph_cli.js --sorting <id> [--base-file <name>.js] [--input <metadata.json>] [--svg <output.svg>] [--html <output.html>] [--title <text>]"
  );
  console.log("");
  console.log("Defaults:");
  console.log(
    `  --base-file: ${defaultBaseFile} (used to resolve ${evolutionRoot}/<base-stem>/...)`
  );
  console.log(
    `  --input: first existing of ${evolutionRoot}/<base-stem>/${fakeMetadataFileName(
      profile.metadataFileName
    )} then ${evolutionRoot}/<base-stem>/${profile.metadataFileName}`
  );
  console.log("  --svg:   <input-dir>/<input-base>.svg");
  console.log("  --html:  <input-dir>/<input-base>.html");
}

function defaultOutputInEvolution(inputPath, extension) {
  const parsed = path.parse(inputPath);
  return path.join(path.dirname(inputPath), `${parsed.name}${extension}`);
}

function buildDefaultInputCandidates(baseFile, profile) {
  const candidates = [];
  const metadataFileName = profile.metadataFileName;
  const defaultBaseFile = `${profile.sortingId}_base_0120.js`;
  const resolvedBaseFile = normalizeBaseFileName(baseFile || defaultBaseFile);
  const evolutionDir = evolutionDirForBase(resolvedBaseFile, profile);
  candidates.push(path.join(evolutionDir, fakeMetadataFileName(metadataFileName)));
  candidates.push(path.join(evolutionDir, metadataFileName));
  return candidates;
}

async function resolveDefaultInput(baseFile, profile) {
  const candidates = buildDefaultInputCandidates(baseFile, profile);
  for (let i = 0; i < candidates.length; i += 1) {
    if (await fileExists(candidates[i])) {
      return candidates[i];
    }
  }

  throw new Error(`No input metadata file found. Checked: ${candidates.join(", ")}`);
}

function parseArgs(argv, profile) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const defaultBaseFile = `${profile.sortingId}_base_0120.js`;
  const args = {
    baseFile: defaultBaseFile,
    input: null,
    svgPath: null,
    htmlPath: null,
    title: ""
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];

    switch (token) {
      case "--base-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-file requires a .js file name.");
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
      case "--svg": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--svg requires a file path.");
        }
        args.svgPath = value;
        i += 1;
        break;
      }
      case "--html": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--html requires a file path.");
        }
        args.htmlPath = value;
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

  return args;
}

export async function runEvolutionGraphCli(argv) {
  const helpProfile = resolveHelpSortingProfile(argv);
  const previewArgs = parseArgs(argv, helpProfile);
  if (previewArgs.help) {
    printHelp(helpProfile);
    return;
  }
  const profile = resolveActiveSortingProfile(argv);
  const args = parseArgs(argv, profile);

  const inputPath = args.input || (await resolveDefaultInput(args.baseFile, profile));
  if (!(await fileExists(inputPath))) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const metadataRaw = await fs.readFile(inputPath, "utf8");
  const metadata = JSON.parse(metadataRaw);
  const svgPath = args.svgPath || defaultOutputInEvolution(inputPath, ".svg");
  const htmlPath = args.htmlPath || defaultOutputInEvolution(inputPath, ".html");
  const artifacts = buildEvolutionGraphArtifacts(metadata, {
    title: args.title || `${profile.graphTitle} (${path.basename(inputPath)})`,
    candidateLabel: profile.candidateLabel,
    svgPath,
    htmlPath
  });

  await fs.mkdir(path.dirname(svgPath), { recursive: true });
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(svgPath, artifacts.svg, "utf8");
  console.log(`SVG written: ${svgPath}`);
  console.log(`Nodes rendered: ${artifacts.nodeCount}`);

  await fs.writeFile(htmlPath, artifacts.html, "utf8");
  console.log(`HTML written: ${htmlPath}`);
}

if (typeof process !== "undefined" && process.argv && process.argv.length >= 2) {
  const invoked = path.resolve(process.argv[1]);
  const current = path.resolve(fileURLToPath(import.meta.url));

  if (invoked === current) {
    runEvolutionGraphCli(process.argv.slice(2)).catch((error) => {
      const message = error && error.message ? error.message : String(error);
      console.error(`Graph CLI failed: ${message}`);
      process.exitCode = 1;
    });
  }
}

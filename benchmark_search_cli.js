import { formatCount } from "./generation_core.js";
import { NATIVE_SORTER } from "./native-sort.js";
import {
  SHARED_BENCHMARK_AB_TESTING,
  SHARED_BENCHMARK_FLOW_ID,
  SHARED_BENCHMARK_ORDER_MODE,
  SHARED_BENCHMARK_STORE_RAW_RUN_VALUES,
  SHARED_BENCHMARK_VALIDATE_SORTED,
  SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION,
  createSorter,
  runSharedPresetSuite,
} from "./shared_benchmark_session_core.js";
import { USE_WARMUP } from "./benchmarks_core.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evolutionDirForBase,
  extractSnapshotIdFromFilePath,
  extractSnapshotIdFromText,
  normalizeSnapshotToken,
  resolveActiveSortingProfile,
  resolveFallbackSortingProfile,
  resolveBaselineTotals,
  resolveCandidateTotals,
  snapshotDirForBase,
  snapshotFileNameFromId,
} from "./sorting_profile_core.js";
import {
  parseCsvList,
  normalizeBaseFileName,
  resolveHelpSortingProfile,
  stripGlobalSortingArgs,
  toPositiveInt,
} from "./cli_arg_utils_core.js";
import { geometricMeanPositive } from "./stats_core.js";
import { fileExists } from "./fs_utils_core.js";

let runtimeProfile = resolveFallbackSortingProfile();

const ALL_PRESET_IDS = Object.freeze(["quick", "medium", "balanced", "large", "huge"]);
const PRESET_ALIASES = Object.freeze({
  quick: "quick",
  small: "quick",
  medium: "medium",
  balanced: "balanced",
  large: "large",
  huge: "huge",
  all: "all",
});
const DEFAULT_OUTPUT_BASE_NAME = "benchmark_search_results";
const DEFAULT_SHORTLIST_FILE_NAME = "shortlist_candidates.json";
const NON_QUICK_RANK_PRESET_IDS = Object.freeze(["medium", "balanced", "large", "huge"]);

function printHelp() {
  const evolutionRoot = `${runtimeProfile.rootDir}/${runtimeProfile.evolutionDirName}`;
  console.log("benchmark search cli");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node benchmark_search_cli.js --sorting <id> --base-file <name>.js (--candidate <path>|--candidates <csv>|--from-shortlist) [options]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>        Required. Select active sorting profile for this run.");
  console.log("  --base-file <name>.js Required. Selects snapshot/evolution context path.");
  console.log("  --candidate <path>    One candidate file or snapshot token (repeatable via CSV).");
  console.log("  --candidates <csv>    Comma-separated candidate files/tokens.");
  console.log("  --from-shortlist      Load candidates from shortlist JSON.");
  console.log(
    `  --shortlist-file <file> Shortlist JSON path (default: ${evolutionRoot}/<base-stem>/${DEFAULT_SHORTLIST_FILE_NAME}).`
  );
  console.log("  --snapshot-dir <dir>  Snapshot directory override.");
  console.log(
    "  --original-file <path> Baseline/original sorter module override (defaults to profile baseline, then --base-file, then working file)."
  );
  console.log("  --presets <csv>       quick,medium,balanced,large,huge,all (default: all).");
  console.log("  --runs <n>            Override measured runs per preset case.");
  console.log("  --ab-testing <on|off> Override AB testing mode for this run.");
  console.log("  --progress            Stream progress lines during execution.");
  console.log(
    `  --out <path>          Report output base path (default: ${evolutionRoot}/<base-stem>/${DEFAULT_OUTPUT_BASE_NAME}).`
  );
  console.log("                        If path ends in .txt/.csv/.json, extension is stripped once.");
  console.log("  --help                Show help.");
}

function defaultSnapshotDirForBase(baseFile) {
  return snapshotDirForBase(baseFile, runtimeProfile);
}

function defaultShortlistFileForBase(baseFile) {
  return path.join(
    evolutionDirForBase(baseFile, runtimeProfile),
    DEFAULT_SHORTLIST_FILE_NAME
  );
}

function defaultOutputBaseForBase(baseFile) {
  return path.join(
    evolutionDirForBase(baseFile, runtimeProfile),
    DEFAULT_OUTPUT_BASE_NAME
  );
}

function normalizeOutputBasePath(value) {
  const absolutePath = path.resolve(process.cwd(), value);
  const parsed = path.parse(absolutePath);
  const extension = parsed.ext.toLowerCase();
  if (extension === ".txt" || extension === ".csv" || extension === ".json") {
    return path.join(parsed.dir, parsed.name);
  }

  return absolutePath;
}

function normalizePresetToken(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "") {
    return "";
  }

  return PRESET_ALIASES[token] || "";
}

function parsePresetList(value) {
  const raw = parseCsvList(value);
  if (raw.length === 0) {
    return [];
  }

  const normalized = [];
  for (let i = 0; i < raw.length; i += 1) {
    const mapped = normalizePresetToken(raw[i]);
    if (!mapped) {
      throw new Error(`Unknown preset: ${raw[i]}`);
    }
    normalized.push(mapped);
  }

  if (normalized.includes("all")) {
    return ALL_PRESET_IDS.slice();
  }

  const deduped = [];
  const seen = new Set();
  for (let i = 0; i < normalized.length; i += 1) {
    const id = normalized[i];
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(id);
  }

  return deduped;
}

function parseBooleanOnOff(value, optionName) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "on" || text === "true" || text === "1") {
    return true;
  }
  if (text === "off" || text === "false" || text === "0") {
    return false;
  }

  throw new Error(`${optionName} expects on|off.`);
}

function normalizeCandidateToken(value, snapshotDir) {
  const token = String(value || "").trim();
  if (token === "") {
    return token;
  }

  const hasPathSeparator = token.includes("/") || token.includes("\\");
  const normalized = normalizeSnapshotToken(token, runtimeProfile);
  const snapshotId = extractSnapshotIdFromText(normalized, runtimeProfile);
  if (snapshotId && !hasPathSeparator) {
    return path.join(snapshotDir, snapshotFileNameFromId(snapshotId, runtimeProfile));
  }

  return token;
}

function tokenFromSnapshotId(snapshotId, snapshotDir) {
  const normalizedId = extractSnapshotIdFromText(snapshotId, runtimeProfile);
  if (!normalizedId) {
    return "";
  }
  return path.join(
    snapshotDir,
    snapshotFileNameFromId(normalizedId, runtimeProfile)
  );
}

function inferCandidateLabel(rawToken, resolvedPath) {
  const token = String(rawToken || "").trim();
  const fromToken = extractSnapshotIdFromText(rawToken, runtimeProfile);
  if (fromToken) {
    return fromToken;
  }

  const fromPath = extractSnapshotIdFromFilePath(
    resolvedPath,
    runtimeProfile
  );
  if (fromPath) {
    return fromPath;
  }

  const fromFile = path.basename(String(resolvedPath || ""));
  return fromFile || token || "candidate";
}

function formatCandidateDisplayName(label, filePath) {
  const text = String(label || "").trim();
  const snapshotIdFromLabel = extractSnapshotIdFromText(
    text,
    runtimeProfile
  );
  if (snapshotIdFromLabel) {
    return `${runtimeProfile.snapshotPrefix}${snapshotIdFromLabel}`.toLowerCase();
  }

  const snapshotIdFromPath = extractSnapshotIdFromFilePath(
    filePath,
    runtimeProfile
  );
  if (snapshotIdFromPath) {
    return `${runtimeProfile.snapshotPrefix}${snapshotIdFromPath}`.toLowerCase();
  }

  const base = path.basename(String(filePath || ""));
  if (base !== "") {
    return base;
  }

  return text || "candidate";
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function formatPct(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatSecondsFromMs(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  return (value / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
    useGrouping: false,
  });
}

function avgImprovementPct(candidateMs, baselineMs) {
  if (!Number.isFinite(candidateMs) || !Number.isFinite(baselineMs) || baselineMs === 0) {
    return Number.NaN;
  }

  return ((baselineMs - candidateMs) / baselineMs) * 100;
}

function ratio(candidateValue, baselineValue) {
  if (!Number.isFinite(candidateValue) || !Number.isFinite(baselineValue) || baselineValue === 0) {
    return Number.NaN;
  }

  return candidateValue / baselineValue;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(6);
}

function compareNumberAsc(left, right) {
  const leftFinite = Number.isFinite(left);
  const rightFinite = Number.isFinite(right);
  if (leftFinite && rightFinite) {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }
  if (leftFinite) {
    return -1;
  }
  if (rightFinite) {
    return 1;
  }
  return 0;
}

function extractSnapshotSortInfo(candidate) {
  const label = String(candidate?.label || "").trim();
  const displayName = String(candidate?.displayName || "").trim();
  const filePath = String(candidate?.filePath || "").trim();

  const snapshotId =
    extractSnapshotIdFromText(label, runtimeProfile) ||
    extractSnapshotIdFromText(displayName, runtimeProfile) ||
    extractSnapshotIdFromFilePath(filePath, runtimeProfile);

  if (snapshotId) {
    return {
      snapshot_id: snapshotId,
      snapshot_sort_num: Number(snapshotId),
    };
  }

  const fallback = displayName || label || filePath || "candidate";
  return {
    snapshot_id: fallback,
    snapshot_sort_num: Number.POSITIVE_INFINITY,
  };
}

function buildFinalRanking(summaries) {
  const rankingSourcePresets = [];
  const nonQuickSummaryByPreset = new Map();
  for (let i = 0; i < summaries.length; i += 1) {
    const summary = summaries[i];
    if (NON_QUICK_RANK_PRESET_IDS.includes(summary.presetId)) {
      nonQuickSummaryByPreset.set(summary.presetId, summary);
      rankingSourcePresets.push(summary.presetId);
    }
  }

  if (rankingSourcePresets.length === 0) {
    return {
      ranking: [],
      rankingSourcePresets,
      champion: null,
      runner_up: null,
      third_place: null,
    };
  }

  const candidateBySorterId = new Map();
  for (let i = 0; i < summaries.length; i += 1) {
    const candidateList = Array.isArray(summaries[i].candidates) ? summaries[i].candidates : [];
    for (let j = 0; j < candidateList.length; j += 1) {
      const candidate = candidateList[j];
      if (!candidateBySorterId.has(candidate.sorterId)) {
        candidateBySorterId.set(candidate.sorterId, candidate);
      }
    }
  }

  const ranking = [];
  for (const [sorterId, candidateMeta] of candidateBySorterId.entries()) {
    const p50Ratios = [];
    const avgRatios = [];
    const vsOriginalP50Ratios = [];
    const usedPresets = [];

    for (let i = 0; i < rankingSourcePresets.length; i += 1) {
      const presetId = rankingSourcePresets[i];
      const summary = nonQuickSummaryByPreset.get(presetId);
      if (!summary) {
        continue;
      }
      const candidate = (summary.candidates || []).find((entry) => entry.sorterId === sorterId);
      if (!candidate) {
        continue;
      }

      const p50Ratio = ratio(Number(candidate.p50Ms), Number(summary.native?.p50Ms));
      const avgRatio = ratio(Number(candidate.avgMs), Number(summary.native?.avgMs));
      const originalP50Ratio = ratio(Number(candidate.p50Ms), Number(summary.original?.p50Ms));
      if (Number.isFinite(p50Ratio)) {
        p50Ratios.push(p50Ratio);
      }
      if (Number.isFinite(avgRatio)) {
        avgRatios.push(avgRatio);
      }
      if (Number.isFinite(originalP50Ratio)) {
        vsOriginalP50Ratios.push(originalP50Ratio);
      }
      usedPresets.push(presetId);
    }

    const nonQuickGeomeanP50 = geometricMeanPositive(p50Ratios);
    const nonQuickGeomeanAvg = geometricMeanPositive(avgRatios);
    const worstNonQuickP50 =
      p50Ratios.length > 0 ? Math.max(...p50Ratios) : Number.NaN;
    const minNonQuickP50 =
      p50Ratios.length > 0 ? Math.min(...p50Ratios) : Number.NaN;
    const spreadNonQuickP50 =
      Number.isFinite(worstNonQuickP50) && Number.isFinite(minNonQuickP50)
        ? worstNonQuickP50 - minNonQuickP50
        : Number.NaN;
    const geomeanVsOriginalP50 = geometricMeanPositive(vsOriginalP50Ratios);
    const snapshotInfo = extractSnapshotSortInfo(candidateMeta);

    if (!Number.isFinite(nonQuickGeomeanP50) || nonQuickGeomeanP50 <= 0 || usedPresets.length === 0) {
      continue;
    }

    ranking.push({
      sorter_id: sorterId,
      snapshot_id: snapshotInfo.snapshot_id,
      snapshot_sort_num: snapshotInfo.snapshot_sort_num,
      used_non_quick_presets: usedPresets,
      non_quick_geomean_p50: nonQuickGeomeanP50,
      non_quick_geomean_avg: nonQuickGeomeanAvg,
      worst_non_quick_p50: worstNonQuickP50,
      spread_non_quick_p50: spreadNonQuickP50,
      geomean_vs_original_p50: geomeanVsOriginalP50,
    });
  }

  ranking.sort((left, right) => {
    let compare = compareNumberAsc(left.non_quick_geomean_p50, right.non_quick_geomean_p50);
    if (compare !== 0) {
      return compare;
    }

    compare = compareNumberAsc(left.worst_non_quick_p50, right.worst_non_quick_p50);
    if (compare !== 0) {
      return compare;
    }

    compare = compareNumberAsc(left.spread_non_quick_p50, right.spread_non_quick_p50);
    if (compare !== 0) {
      return compare;
    }

    compare = compareNumberAsc(left.non_quick_geomean_avg, right.non_quick_geomean_avg);
    if (compare !== 0) {
      return compare;
    }

    compare = compareNumberAsc(left.snapshot_sort_num, right.snapshot_sort_num);
    if (compare !== 0) {
      return compare;
    }

    if (left.snapshot_id < right.snapshot_id) {
      return -1;
    }
    if (left.snapshot_id > right.snapshot_id) {
      return 1;
    }
    return 0;
  });

  return {
    ranking,
    rankingSourcePresets,
    champion: ranking.length > 0 ? ranking[0] : null,
    runner_up: ranking.length > 1 ? ranking[1] : null,
    third_place: ranking.length > 2 ? ranking[2] : null,
  };
}

function csvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "";
    }
    return String(value);
  }

  const text = String(value);
  if (text.includes(";") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function resolveCandidatePath(inputPath) {
  const directPath = path.resolve(process.cwd(), inputPath);
  if (await fileExists(directPath)) {
    return directPath;
  }

  return directPath;
}

async function resolveOriginalSorterPath(args) {
  const tried = [];
  const candidates = [];

  if (typeof args.originalFile === "string" && args.originalFile.trim() !== "") {
    candidates.push(String(args.originalFile).trim());
  }
  if (typeof runtimeProfile.baselineFile === "string" && runtimeProfile.baselineFile.trim() !== "") {
    candidates.push(String(runtimeProfile.baselineFile).trim());
  }
  if (typeof args.baseFile === "string" && args.baseFile.trim() !== "") {
    candidates.push(String(args.baseFile).trim());
  }
  if (typeof runtimeProfile.workingFile === "string" && runtimeProfile.workingFile.trim() !== "") {
    candidates.push(String(runtimeProfile.workingFile).trim());
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const absolutePath = path.resolve(process.cwd(), candidates[i]);
    if (tried.includes(absolutePath)) {
      continue;
    }
    tried.push(absolutePath);
    if (await fileExists(absolutePath)) {
      return absolutePath;
    }
  }

  throw new Error(
    `Unable to locate original sorter file. Tried: ${tried.join(", ")}`
  );
}

async function loadOriginalSorter(args) {
  const baselinePath = await resolveOriginalSorterPath(args);
  const moduleUrl = pathToFileURL(baselinePath);
  moduleUrl.searchParams.set("originalSorter", String(Date.now()));
  let loadedModule;
  try {
    loadedModule = await import(moduleUrl.href);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Failed to import baseline sorter (${baselinePath}): ${message}`);
  }

  if (!loadedModule || typeof loadedModule.default !== "function") {
    throw new Error(
      `Baseline sorter must export a default function: ${baselinePath}`
    );
  }

  return createSorter("original", path.basename(baselinePath), loadedModule.default);
}

function parseArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    baseFile: null,
    originalFile: null,
    snapshotDir: null,
    candidates: [],
    runsOverride: null,
    outputBase: null,
    presets: ALL_PRESET_IDS.slice(),
    fromShortlist: false,
    shortlistFile: null,
    progress: false,
    abTestingOverride: null,
  };

  for (let i = 0; i < filteredArgv.length; i += 1) {
    const token = filteredArgv[i];
    if (token.startsWith("--base-file=")) {
      const value = token.slice(token.indexOf("=") + 1);
      args.baseFile = normalizeBaseFileName(value);
      continue;
    }
    if (token.startsWith("--presets=")) {
      const value = token.slice(token.indexOf("=") + 1);
      const parsed = parsePresetList(value);
      if (parsed.length === 0) {
        throw new Error("--presets requires one or more preset ids.");
      }
      args.presets = parsed;
      continue;
    }
    if (token.startsWith("--snapshot-dir=")) {
      const value = token.slice(token.indexOf("=") + 1);
      if (!value) {
        throw new Error("--snapshot-dir requires a value.");
      }
      args.snapshotDir = value;
      continue;
    }
    if (token.startsWith("--original-file=")) {
      const value = token.slice(token.indexOf("=") + 1);
      if (!value) {
        throw new Error("--original-file requires a value.");
      }
      args.originalFile = value;
      continue;
    }
    if (token.startsWith("--ab-testing=")) {
      const value = token.slice(token.indexOf("=") + 1);
      args.abTestingOverride = parseBooleanOnOff(value, "--ab-testing");
      continue;
    }
    switch (token) {
      case "--candidate": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires a value.`);
        }
        const items = parseCsvList(value);
        if (items.length === 0) {
          throw new Error(`${token} requires a non-empty value.`);
        }
        for (let j = 0; j < items.length; j += 1) {
          args.candidates.push(items[j]);
        }
        i += 1;
        break;
      }
      case "--base-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--base-file requires a value.");
        }
        args.baseFile = normalizeBaseFileName(value);
        i += 1;
        break;
      }
      case "--snapshot-dir": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--snapshot-dir requires a value.");
        }
        args.snapshotDir = value;
        i += 1;
        break;
      }
      case "--original-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--original-file requires a value.");
        }
        args.originalFile = value;
        i += 1;
        break;
      }
      case "--candidates": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--candidates requires a comma-separated value.");
        }
        const items = parseCsvList(value);
        if (items.length === 0) {
          throw new Error("--candidates requires a non-empty comma-separated value.");
        }
        for (let j = 0; j < items.length; j += 1) {
          args.candidates.push(items[j]);
        }
        i += 1;
        break;
      }
      case "--runs": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--runs requires a value.");
        }
        args.runsOverride = toPositiveInt(value, 0);
        if (args.runsOverride <= 0) {
          throw new Error("--runs must be a positive integer.");
        }
        i += 1;
        break;
      }
      case "--from-shortlist": {
        args.fromShortlist = true;
        break;
      }
      case "--progress": {
        args.progress = true;
        break;
      }
      case "--shortlist-file": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--shortlist-file requires a value.");
        }
        args.shortlistFile = value;
        i += 1;
        break;
      }
      case "--ab-testing": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--ab-testing requires on|off.");
        }
        args.abTestingOverride = parseBooleanOnOff(value, "--ab-testing");
        i += 1;
        break;
      }
      case "--presets": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires a value.`);
        }
        const parsed = parsePresetList(value);
        if (parsed.length === 0) {
          throw new Error("--presets requires one or more preset ids.");
        }
        args.presets = parsed;
        i += 1;
        break;
      }
      case "--out": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error(`${token} requires a file path.`);
        }
        args.outputBase = value;
        i += 1;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  if (args.candidates.length === 0 && !args.fromShortlist) {
    throw new Error("Missing candidates. Provide --candidate/--candidates or use --from-shortlist.");
  }

  const deduped = [];
  const seen = new Set();
  for (let i = 0; i < args.candidates.length; i += 1) {
    const key = String(args.candidates[i] || "").trim();
    if (key === "" || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(key);
  }
  args.candidates = deduped;
  if (!args.baseFile) {
    throw new Error("Missing required option: --base-file <name>.js");
  }
  if (!args.snapshotDir) {
    args.snapshotDir = defaultSnapshotDirForBase(args.baseFile);
  }
  if (!args.shortlistFile) {
    args.shortlistFile = defaultShortlistFileForBase(args.baseFile);
  }
  if (!args.outputBase) {
    args.outputBase = defaultOutputBaseForBase(args.baseFile);
  }

  return args;
}

async function readCandidateTokensFromShortlist(shortlistFilePath, snapshotDir) {
  const filePath = path.resolve(process.cwd(), shortlistFilePath);
  const text = await fs.readFile(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Invalid shortlist JSON (${filePath}): ${message}`);
  }

  const shortlist = Array.isArray(parsed?.shortlist) ? parsed.shortlist : [];
  if (shortlist.length === 0) {
    throw new Error(`Shortlist is empty in ${filePath}`);
  }

  const tokens = [];
  for (let i = 0; i < shortlist.length; i += 1) {
    const item = shortlist[i];
    const token = tokenFromSnapshotId(item?.snapshot_id, snapshotDir);
    if (token !== "") {
      tokens.push(token);
    }
  }

  if (tokens.length === 0) {
    throw new Error(`No valid snapshot_id entries found in ${filePath}`);
  }

  return tokens;
}

async function loadCandidateSorter(inputToken, candidateIndex, snapshotDir) {
  const normalizedToken = normalizeCandidateToken(inputToken, snapshotDir);
  const resolvedPath = await resolveCandidatePath(normalizedToken);
  const moduleUrl = pathToFileURL(resolvedPath).href;
  let loadedModule;

  try {
    loadedModule = await import(moduleUrl);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(
      `Failed to import candidate sorter (${inputToken} -> ${resolvedPath}): ${message}`
    );
  }

  if (!loadedModule || typeof loadedModule.default !== "function") {
    throw new Error(`Candidate sorter must export a default function: ${resolvedPath}`);
  }

  const label = inferCandidateLabel(inputToken, resolvedPath);
  const sorterId = `candidate_${candidateIndex + 1}`;
  const relativeReportPath = path.relative(process.cwd(), resolvedPath) || path.basename(resolvedPath);

  return Object.freeze({
    token: String(inputToken),
    label,
    displayName: formatCandidateDisplayName(label, resolvedPath),
    filePath: relativeReportPath,
    sorter: createSorter(sorterId, path.basename(resolvedPath), loadedModule.default),
  });
}

function formatPresetHeaderLine(item) {
  const label = `${item.presetId} (${formatCount(item.rowCount)} rows)`;
  const nativeText = `${formatMs(item.native.avgMs)}/${formatMs(item.native.p50Ms)}`;
  const originalText = `${formatMs(item.original.avgMs)}/${formatMs(item.original.p50Ms)}`;
  return `${label}  native ${nativeText} | original ${originalText}`;
}

function formatCandidateMatrixLine(candidate) {
  const candidateText = `${formatMs(candidate.avgMs)}/${formatMs(candidate.p50Ms)}`;
  const vsNative = `${formatPct(candidate.candidateVsNativeAvgPct)}/${formatPct(candidate.candidateVsNativeP50Pct)}`;
  const vsOriginal = `${formatPct(candidate.candidateVsOriginalAvgPct)}/${formatPct(candidate.candidateVsOriginalP50Pct)}`;
  return `  ${String(candidate.displayName).padEnd(12, " ")} ${candidateText} | vs native(avg/p50) ${vsNative} | vs original(avg/p50) ${vsOriginal}`;
}

function buildCsvRows(summaries) {
  const rows = [
    [
      "preset_id",
      "row_count",
      "runs_per_case",
      "sorter",
      "sorter_label",
      "avg_ms",
      "p50_ms",
      "vs_native_avg_pct",
      "vs_native_p50_pct",
      "vs_original_avg_pct",
      "vs_original_p50_pct",
      "session_measured_total_ms",
    ],
  ];

  for (let i = 0; i < summaries.length; i += 1) {
    const summary = summaries[i];
    rows.push([
      summary.presetId,
      summary.rowCount,
      summary.runs,
      "native",
      "Array.prototype.sort",
      summary.native.avgMs,
      summary.native.p50Ms,
      "",
      "",
      "",
      "",
      summary.sessionMeasuredTotalMs,
    ]);
    rows.push([
      summary.presetId,
      summary.rowCount,
      summary.runs,
      "original",
      summary.original.label || runtimeProfile.baselineFile,
      summary.original.avgMs,
      summary.original.p50Ms,
      summary.originalVsNativeAvgPct,
      summary.originalVsNativeP50Pct,
      "",
      "",
      summary.sessionMeasuredTotalMs,
    ]);

    for (let j = 0; j < summary.candidates.length; j += 1) {
      const candidate = summary.candidates[j];
      rows.push([
        summary.presetId,
        summary.rowCount,
        summary.runs,
        candidate.sorterId,
        candidate.label,
        candidate.avgMs,
        candidate.p50Ms,
        candidate.candidateVsNativeAvgPct,
        candidate.candidateVsNativeP50Pct,
        candidate.candidateVsOriginalAvgPct,
        candidate.candidateVsOriginalP50Pct,
        summary.sessionMeasuredTotalMs,
      ]);
    }
  }

  return rows;
}

function csvRowsToText(rows) {
  const lines = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    lines[i] = rows[i].map((value) => csvValue(value)).join(";");
  }

  return `${lines.join("\n")}\n`;
}

async function main(argv) {
  if (Array.isArray(argv) && (argv.includes("--help") || argv.includes("-h"))) {
    runtimeProfile = resolveHelpSortingProfile(argv);
    printHelp();
    return;
  }
  runtimeProfile = resolveActiveSortingProfile(argv);

  const args = parseArgs(argv);
  const mergedTokens = args.candidates.slice();
  if (args.fromShortlist) {
    const shortlistTokens = await readCandidateTokensFromShortlist(
      args.shortlistFile,
      args.snapshotDir
    );
    for (let i = 0; i < shortlistTokens.length; i += 1) {
      mergedTokens.push(shortlistTokens[i]);
    }
  }

  const dedupedTokens = [];
  const seenTokens = new Set();
  for (let i = 0; i < mergedTokens.length; i += 1) {
    const token = String(mergedTokens[i] || "").trim();
    if (token === "" || seenTokens.has(token)) {
      continue;
    }
    seenTokens.add(token);
    dedupedTokens.push(token);
  }
  if (dedupedTokens.length === 0) {
    throw new Error("No candidate tokens resolved.");
  }

  const candidates = [];
  for (let i = 0; i < dedupedTokens.length; i += 1) {
    candidates.push(await loadCandidateSorter(dedupedTokens[i], i, args.snapshotDir));
  }

  const originalSorter = await loadOriginalSorter(args);
  const sorters = [NATIVE_SORTER, originalSorter];
  for (let i = 0; i < candidates.length; i += 1) {
    sorters.push(candidates[i].sorter);
  }

  const targetSorterIds = [originalSorter.id];
  for (let i = 0; i < candidates.length; i += 1) {
    targetSorterIds.push(candidates[i].sorter.id);
  }

  const suite = runSharedPresetSuite({
    presetIds: args.presets,
    sorters,
    baselineSorterId: NATIVE_SORTER.id,
    targetSorterIds,
    benchmarkRunsOverride: args.runsOverride,
    orderMode: SHARED_BENCHMARK_ORDER_MODE,
    abTesting:
      typeof args.abTestingOverride === "boolean"
        ? args.abTestingOverride
        : SHARED_BENCHMARK_AB_TESTING,
    useWarmup: USE_WARMUP,
    warmupRunsPerCombination: SHARED_BENCHMARK_WARMUP_RUNS_PER_COMBINATION,
    storeRawRuns: SHARED_BENCHMARK_STORE_RAW_RUN_VALUES,
    validateSorted: SHARED_BENCHMARK_VALIDATE_SORTED,
    onPresetComplete: args.progress
      ? (info) => {
          const warmupText = USE_WARMUP
            ? `, warmup ${formatSecondsFromMs(Number(info.warmupTotalMs))} s`
            : "";
          console.log(
            `[progress] preset ${info.presetId} done (${formatCount(
              Number(info.rowCount)
            )} rows, runs ${Number(info.runsPerCase)}): measured ${formatSecondsFromMs(
              Number(info.measuredTotalMs)
            )} s${warmupText}`
          );
        }
      : null,
  });

  const summaries = [];
  for (let i = 0; i < args.presets.length; i += 1) {
    const presetId = args.presets[i];
    const originalTotals = suite.totalsByTargetId[originalSorter.id]?.[presetId];
    if (!originalTotals) {
      throw new Error(`Missing original totals for preset ${presetId}.`);
    }

    const native = resolveBaselineTotals(originalTotals);
    const original = resolveCandidateTotals(originalTotals);
    if (!native || !original) {
      throw new Error(`Missing baseline/candidate totals for original sorter on preset ${presetId}.`);
    }
    const candidateSummaries = [];

    for (let j = 0; j < candidates.length; j += 1) {
      const candidate = candidates[j];
      const candidateTotals = suite.totalsByTargetId[candidate.sorter.id]?.[presetId];
      if (!candidateTotals) {
        throw new Error(
          `Missing candidate totals for ${candidate.label} (${candidate.sorter.id}) on preset ${presetId}.`
        );
      }
      const candidateTotalsMetrics = resolveCandidateTotals(candidateTotals);
      if (!candidateTotalsMetrics) {
        throw new Error(
          `Missing candidate benchmark metrics for ${candidate.label} on preset ${presetId}.`
        );
      }

      candidateSummaries.push({
        token: candidate.token,
        label: candidate.label,
        displayName: candidate.displayName,
        filePath: candidate.filePath,
        sorterId: candidate.sorter.id,
        avgMs: candidateTotalsMetrics.avgMs,
        p50Ms: candidateTotalsMetrics.p50Ms,
        candidateVsNativeAvgPct: Number(candidateTotals.improvementVsNativePct),
        candidateVsNativeP50Pct: avgImprovementPct(
          Number(candidateTotalsMetrics.p50Ms),
          Number(native.p50Ms)
        ),
        candidateVsOriginalAvgPct: avgImprovementPct(
          Number(candidateTotalsMetrics.avgMs),
          Number(original.avgMs)
        ),
        candidateVsOriginalP50Pct: avgImprovementPct(
          Number(candidateTotalsMetrics.p50Ms),
          Number(original.p50Ms)
        ),
      });
    }

    summaries.push({
      presetId,
      rowCount: Number(originalTotals.rowCount),
      runs: Number(originalTotals.runsPerCase),
      native: {
        avgMs: Number(native.avgMs),
        p50Ms: Number(native.p50Ms),
      },
      original: {
        label: originalSorter.label,
        avgMs: Number(original.avgMs),
        p50Ms: Number(original.p50Ms),
      },
      originalVsNativeAvgPct: avgImprovementPct(Number(original.avgMs), Number(native.avgMs)),
      originalVsNativeP50Pct: avgImprovementPct(Number(original.p50Ms), Number(native.p50Ms)),
      candidates: candidateSummaries,
      sessionMeasuredTotalMs: Number(suite.sessionMeasuredTotalByPreset[presetId]),
    });
  }

  const lines = [];
  lines.push("Benchmark search (parity mode): shared preset session with native + targets.");
  lines.push(
    `Flow=${SHARED_BENCHMARK_FLOW_ID}, order=${suite.orderMode}, AB_TESTING=${suite.abTestingEnabled ? "on" : "off"}, warmup=${suite.warmupEnabled ? "on" : "off"}`
  );
  lines.push(
    `Warmup runs per combination=${suite.warmupRunsPerCombination}, validate_sorted=${SHARED_BENCHMARK_VALIDATE_SORTED ? "on" : "off"}`
  );
  lines.push(`Presets: ${args.presets.join(", ")}`);
  if (args.fromShortlist) {
    lines.push(`Candidates source: shortlist (${path.resolve(process.cwd(), args.shortlistFile)})`);
  }
  lines.push(
    `Benchmark matrix: native vs ${originalSorter.label} vs ${candidates.length} candidates`
  );
  lines.push(`Candidates: ${candidates.map((item) => item.label).join(", ")}`);
  lines.push("Columns use avg/p50 in ms. Percent deltas are shown as avg/p50.");
  for (let i = 0; i < summaries.length; i += 1) {
    lines.push(formatPresetHeaderLine(summaries[i]));
    for (let j = 0; j < summaries[i].candidates.length; j += 1) {
      lines.push(formatCandidateMatrixLine(summaries[i].candidates[j]));
    }
  }

  const finalRanking = buildFinalRanking(summaries);
  lines.push("");
  lines.push("Final ranking (non-quick presets):");
  lines.push(
    `Ranking presets used (non-quick): ${
      finalRanking.rankingSourcePresets.length > 0
        ? finalRanking.rankingSourcePresets.join(", ")
        : "none"
    }`
  );
  if (finalRanking.ranking.length === 0) {
    lines.push("No candidates available for non-quick ranking.");
  } else {
    for (let i = 0; i < finalRanking.ranking.length; i += 1) {
      const item = finalRanking.ranking[i];
      lines.push(
        `${i + 1}. ${item.snapshot_id} | geomean_p50=${formatRatio(
          item.non_quick_geomean_p50
        )} | geomean_avg=${formatRatio(item.non_quick_geomean_avg)} | worst=${formatRatio(
          item.worst_non_quick_p50
        )} | spread=${formatRatio(item.spread_non_quick_p50)} | vs_original=${formatRatio(
          item.geomean_vs_original_p50
        )}`
      );
    }
    lines.push(
      `Champion: ${finalRanking.champion ? finalRanking.champion.snapshot_id : "n/a"}`
    );
    lines.push(
      `Runner-up: ${finalRanking.runner_up ? finalRanking.runner_up.snapshot_id : "n/a"}`
    );
    lines.push(
      `Third place: ${finalRanking.third_place ? finalRanking.third_place.snapshot_id : "n/a"}`
    );
  }

  const outBaseAbsolute = normalizeOutputBasePath(args.outputBase);
  const outDir = path.dirname(outBaseAbsolute);
  const outText = `${outBaseAbsolute}.txt`;
  const outCsv = `${outBaseAbsolute}.csv`;
  const outJson = `${outBaseAbsolute}.json`;
  await fs.mkdir(outDir, { recursive: true });

  const textContent = `${lines.join("\n")}\n`;
  await fs.writeFile(outText, textContent, "utf8");

  const csvRows = buildCsvRows(summaries);
  const csvContent = csvRowsToText(csvRows);
  await fs.writeFile(outCsv, csvContent, "utf8");

  const payload = {
    generated_at: new Date().toISOString(),
    benchmark_flow: SHARED_BENCHMARK_FLOW_ID,
    presets: args.presets,
    parity_config: {
      order_mode: suite.orderMode,
      ab_testing: suite.abTestingEnabled,
      warmup_enabled: suite.warmupEnabled,
      warmup_runs_per_combination: suite.warmupRunsPerCombination,
      validate_sorted: SHARED_BENCHMARK_VALIDATE_SORTED,
      raw_run_values_stored: SHARED_BENCHMARK_STORE_RAW_RUN_VALUES,
    },
    baseline: {
      id: NATIVE_SORTER.id,
      label: NATIVE_SORTER.label,
    },
    original: {
      id: originalSorter.id,
      label: originalSorter.label,
    },
    candidates: candidates.map((candidate) => ({
      token: candidate.token,
      label: candidate.label,
      display_name: candidate.displayName,
      file_path: candidate.filePath,
      sorter_id: candidate.sorter.id,
    })),
    summaries,
    final_ranking: finalRanking.ranking,
    ranking_presets_used_non_quick: finalRanking.rankingSourcePresets,
    champion: finalRanking.champion,
    runner_up: finalRanking.runner_up,
    third_place: finalRanking.third_place,
  };
  await fs.writeFile(outJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  for (let i = 0; i < lines.length; i += 1) {
    console.log(lines[i]);
  }
  console.log(`Text report: ${outText}`);
  console.log(`CSV report: ${outCsv}`);
  console.log(`JSON report: ${outJson}`);
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
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`benchmark_search_cli failed: ${message}`);
    process.exitCode = 1;
  }
}

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
  stripGlobalSortingArgs,
  toPositiveInt,
} from "./cli_arg_utils_core.js";
import { geometricMeanPositive, mad, median } from "./stats_core.js";

const DEFAULT_OUTPUT_TEXT_FILE_NAME = "shortlist_candidates.txt";
const DEFAULT_OUTPUT_JSON_FILE_NAME = "shortlist_candidates.json";
const DEFAULT_TOP_N = 8;
const TOP_OVERALL_DIAGNOSTIC_COUNT = 10;

// Noise and quality guardrails.
const OUTLIER_MAD_MULTIPLIER = 3;
const OUTLIER_RELATIVE_FALLBACK = 0.15;
const DISPLAY_VS_OVERALL_GAP_PCT = 5;
const WORST_PRESET_SCORE_HARD_LIMIT = 1.02;
const STRONG_NOISE_PENALTY_THRESHOLD = 2;
const STRICT_NATIVE_OUTLIER_DROP = false;

function defaultInputFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    profile.progressJsonlFileName
  );
}

function defaultOutputTextFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    DEFAULT_OUTPUT_TEXT_FILE_NAME
  );
}

function defaultOutputJsonFileForBase(baseFile, profile) {
  return path.join(
    evolutionDirForBase(baseFile, profile),
    DEFAULT_OUTPUT_JSON_FILE_NAME
  );
}

function printHelp(profile) {
  const evolutionRoot = `${profile.rootDir}/${profile.evolutionDirName}`;
  console.log(
    `Build shortlist candidates from ${evolutionRoot}/<base-stem>/${profile.progressJsonlFileName}.`
  );
  console.log("");
  console.log("Usage:");
  console.log("  node shortlist_candidates_cli.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --sorting <id>            Required. Select active sorting profile for this run.");
  console.log(`  --base-file <name>.js     Required. Selects ${evolutionRoot}/<base-stem>/... paths.`);
  console.log(
    `  --input <file>            Input JSONL file (default: ${evolutionRoot}/<base-stem>/${profile.progressJsonlFileName})`
  );
  console.log(
    `  --out-text <file>         Output shortlist text file (default: ${evolutionRoot}/<base-stem>/${DEFAULT_OUTPUT_TEXT_FILE_NAME})`
  );
  console.log(
    `  --out-json <file>         Output shortlist JSON file (default: ${evolutionRoot}/<base-stem>/${DEFAULT_OUTPUT_JSON_FILE_NAME})`
  );
  console.log(`  --top <n>                 Number of candidates to shortlist (default: ${DEFAULT_TOP_N})`);
  console.log("  --strict-noise            Drop native-outlier rows instead of only down-ranking.");
  console.log("  --help                    Show help");
}

function parseArgs(argv) {
  const filteredArgv = stripGlobalSortingArgs(argv);
  const args = {
    baseFile: null,
    input: null,
    outText: null,
    outJson: null,
    top: DEFAULT_TOP_N,
    strictNoise: STRICT_NATIVE_OUTLIER_DROP,
    help: false,
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
      case "--out-text": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out-text requires a file path.");
        }
        args.outText = value;
        i += 1;
        break;
      }
      case "--out-json": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--out-json requires a file path.");
        }
        args.outJson = value;
        i += 1;
        break;
      }
      case "--top": {
        const value = filteredArgv[i + 1];
        if (!value) {
          throw new Error("--top requires a numeric value.");
        }
        args.top = toPositiveInt(value, DEFAULT_TOP_N);
        i += 1;
        break;
      }
      case "--strict-noise": {
        args.strictNoise = true;
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

function asString(value, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function getField(record, primaryKey, fallbackValue = "") {
  if (Object.prototype.hasOwnProperty.call(record, primaryKey)) {
    return record[primaryKey];
  }
  return fallbackValue;
}

function parseFlexibleNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = asString(value, "").trim();
  if (text === "" || text === "n/a" || text === "xxx") {
    return Number.NaN;
  }

  const match = text.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) {
    return Number.NaN;
  }

  const normalized = match[0].replace(",", ".");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function parseIdNumber(snapshotId) {
  const numeric = Number.parseInt(asString(snapshotId, ""), 10);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function buildCandidateFromRecord(record) {
  const snapshotId = asString(getField(record, "snapshot_id", ""));
  const status = asString(getField(record, "status", "unknown")).toLowerCase();
  const branch = asString(getField(record, "branch", "unknown"));
  const familySegments = branch.split(".");
  const family = familySegments.slice(0, 3).join(".");
  const benchmarkPreset = asString(getField(record, "benchmark_preset", ""));

  const quickScore = parseFlexibleNumber(
    getField(record, "preset_quick_score_p50", Number.NaN)
  );
  const mediumScore = parseFlexibleNumber(
    getField(record, "preset_medium_score_p50", Number.NaN)
  );
  const balancedScore = parseFlexibleNumber(
    getField(record, "preset_balanced_score_p50", Number.NaN)
  );
  const overallScore = parseFlexibleNumber(
    getField(record, "overall_score_p50", Number.NaN)
  );
  const deltaVsAnchorOverall = parseFlexibleNumber(
    getField(
      record,
      "delta_vs_anchor_overall_score_p50",
      Number.NaN
    )
  );
  const testsFailed = parseFlexibleNumber(
    getField(record, "tests_failed", Number.NaN)
  );
  const nativeP50 = parseFlexibleNumber(getField(record, "native_p50", Number.NaN));
  const displayImprovement = parseFlexibleNumber(
    getField(
      record,
      "display_preset_improvement_vs_native_p50",
      Number.NaN
    )
  );
  const overallImprovement = Number.isFinite(overallScore) ? (1 - overallScore) * 100 : Number.NaN;
  const worstPresetScore = Math.max(quickScore, mediumScore, balancedScore);
  const minPresetScore = Math.min(quickScore, mediumScore, balancedScore);
  const presetSpread = Number.isFinite(worstPresetScore) && Number.isFinite(minPresetScore)
    ? worstPresetScore - minPresetScore
    : Number.NaN;
  const quickMediumScore = geometricMeanPositive([quickScore, mediumScore]);

  return {
    type: asString(getField(record, "type", "snapshot")),
    snapshot_id: snapshotId,
    snapshot_num: parseIdNumber(snapshotId),
    status,
    parent: asString(getField(record, "parent", "")),
    branch,
    family,
    depth: asString(getField(record, "depth", "")),
    idea: asString(getField(record, "idea", "")),
    benchmark_preset: benchmarkPreset,
    quick_score_p50: quickScore,
    medium_score_p50: mediumScore,
    balanced_score_p50: balancedScore,
    overall_score_p50: overallScore,
    delta_vs_anchor_overall_score_p50: deltaVsAnchorOverall,
    tests_failed: Number.isFinite(testsFailed) ? testsFailed : Number.NaN,
    native_p50: nativeP50,
    display_preset_improvement_vs_native_p50: displayImprovement,
    improvement_vs_native_overall_p50: overallImprovement,
    worst_preset_score: worstPresetScore,
    preset_spread: presetSpread,
    quick_medium_score: quickMediumScore,
    noise_flag: false,
    noise_penalty: 0,
    noise_reasons: [],
    selection_role: "",
  };
}

function isBenchmarkValidCandidate(candidate) {
  if (!candidate || candidate.type !== "snapshot") {
    return false;
  }
  if (!Number.isFinite(candidate.tests_failed) || candidate.tests_failed > 0) {
    return false;
  }
  if (!Number.isFinite(candidate.overall_score_p50)) {
    return false;
  }
  if (!Number.isFinite(candidate.quick_score_p50)) {
    return false;
  }
  if (!Number.isFinite(candidate.medium_score_p50)) {
    return false;
  }
  if (!Number.isFinite(candidate.balanced_score_p50)) {
    return false;
  }

  return true;
}

function compareCandidates(left, right) {
  if (left.overall_score_p50 !== right.overall_score_p50) {
    return left.overall_score_p50 - right.overall_score_p50;
  }

  if (left.worst_preset_score !== right.worst_preset_score) {
    return left.worst_preset_score - right.worst_preset_score;
  }

  if (left.preset_spread !== right.preset_spread) {
    return left.preset_spread - right.preset_spread;
  }

  const leftNoisePenalty = Number.isFinite(left.noise_penalty) ? left.noise_penalty : 0;
  const rightNoisePenalty = Number.isFinite(right.noise_penalty) ? right.noise_penalty : 0;
  if (leftNoisePenalty !== rightNoisePenalty) {
    return leftNoisePenalty - rightNoisePenalty;
  }

  const leftDelta = Number.isFinite(left.delta_vs_anchor_overall_score_p50)
    ? left.delta_vs_anchor_overall_score_p50
    : Number.NEGATIVE_INFINITY;
  const rightDelta = Number.isFinite(right.delta_vs_anchor_overall_score_p50)
    ? right.delta_vs_anchor_overall_score_p50
    : Number.NEGATIVE_INFINITY;
  if (leftDelta !== rightDelta) {
    return rightDelta - leftDelta;
  }

  return left.snapshot_num - right.snapshot_num;
}

function formatNumber(value, digits = 6) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(digits);
}

function formatPct(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(3)}%`;
}

function compareByOverallScore(left, right) {
  if (left.overall_score_p50 !== right.overall_score_p50) {
    return left.overall_score_p50 - right.overall_score_p50;
  }
  return left.snapshot_num - right.snapshot_num;
}

function addCandidateIfEligible(list, candidate, selectedIdSet, role) {
  if (!candidate) {
    return false;
  }
  if (selectedIdSet.has(candidate.snapshot_id)) {
    return false;
  }

  candidate.selection_role = role;
  list.push(candidate);
  selectedIdSet.add(candidate.snapshot_id);
  return true;
}

function selectFromSorted(sorted, selected, selectedIdSet, maxToAdd, role, predicate) {
  let added = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (added >= maxToAdd) {
      break;
    }
    const candidate = sorted[i];
    if (typeof predicate === "function" && !predicate(candidate)) {
      continue;
    }
    if (addCandidateIfEligible(selected, candidate, selectedIdSet, role)) {
      added += 1;
    }
  }

  return added;
}

function shortlistCandidates(candidates, options) {
  const sorted = candidates.slice().sort(compareCandidates);
  const selected = [];
  const selectedIdSet = new Set();

  selectFromSorted(
    sorted,
    selected,
    selectedIdSet,
    options.top,
    "top_ranked",
    () => true
  );

  return {
    sorted,
    selected,
  };
}

function buildTextOutput(data) {
  const lines = [];
  lines.push(`Shortlist generated at ${data.generated_at}`);
  lines.push(`Input: ${data.input_file}`);
  lines.push(
    `Counts: records=${data.counts.records}, snapshots=${data.counts.snapshots}, benchmark_valid=${data.counts.benchmark_valid}, after_filters=${data.counts.after_filters}, shortlisted=${data.counts.shortlisted}`
  );
  lines.push(`Config: top=${data.config.top}, strict_noise=${data.config.strict_noise}`);
  lines.push(
    `Noise policy: MADx${OUTLIER_MAD_MULTIPLIER}, rel_fallback=${(OUTLIER_RELATIVE_FALLBACK * 100).toFixed(1)}%, display_overall_gap>${DISPLAY_VS_OVERALL_GAP_PCT.toFixed(1)}%`
  );
  lines.push("");
  lines.push(`Top ${data.config.top_overall_diagnostic_count} By overall_score_p50:`);
  for (let i = 0; i < data.top_overall_by_score.length; i += 1) {
    const item = data.top_overall_by_score[i];
    lines.push(
      `${i + 1}. snapshot=${item.snapshot_id} | overall=${formatNumber(item.overall_score_p50)}`
    );
  }

  lines.push("");
  lines.push(`Shortlist (${data.shortlist.length} selected):`);
  for (let i = 0; i < data.shortlist.length; i += 1) {
    const item = data.shortlist[i];
    lines.push(
      `${i + 1}. snapshot=${item.snapshot_id} | role=${item.selection_role} | status=${item.status} | branch=${item.branch} | family=${item.family} | overall=${formatNumber(item.overall_score_p50)} | quick=${formatNumber(item.quick_score_p50)} | medium=${formatNumber(item.medium_score_p50)} | balanced=${formatNumber(item.balanced_score_p50)} | worst=${formatNumber(item.worst_preset_score)} | spread=${formatNumber(item.preset_spread)} | delta_vs_anchor=${formatPct(item.delta_vs_anchor_overall_score_p50)} | noise_penalty=${item.noise_penalty} | idea=${item.idea}`
    );
  }

  if (Array.isArray(data.excluded_top_overall) && data.excluded_top_overall.length > 0) {
    lines.push("");
    lines.push("Excluded Top-Overall (Not In Shortlist) With Reasons:");
    for (let i = 0; i < data.excluded_top_overall.length; i += 1) {
      const item = data.excluded_top_overall[i];
      lines.push(
        `${i + 1}. snapshot=${item.snapshot_id} | overall=${formatNumber(
          item.overall_score_p50
        )} | family=${item.family} | reasons=${Array.isArray(item.excluded_reasons) ? item.excluded_reasons.join(",") : "n/a"}`
      );
    }
  }

  lines.push("");
  lines.push("Important Decision Metrics (End):");
  for (let i = 0; i < data.shortlist.length; i += 1) {
    const item = data.shortlist[i];
    lines.push(
      `${i + 1}. snapshot=${item.snapshot_id} | overall_score_p50=${formatNumber(
        item.overall_score_p50
      )} | worst_preset_score=${formatNumber(item.worst_preset_score)} | preset_spread=${formatNumber(
        item.preset_spread
      )} | delta_vs_anchor_overall_score_p50=${formatPct(
        item.delta_vs_anchor_overall_score_p50
      )} | improvement_vs_native_overall_p50=${formatPct(item.improvement_vs_native_overall_p50)}`
    );
  }

  lines.push("");
  lines.push("Selection Criteria (End):");
  lines.push("1. Hard filters: benchmark-valid snapshot rows, tests_failed=0, full suite scores present.");
  lines.push(
    `2. Hard filters (continued): improvement_vs_native_overall_p50>0 and worst_preset_score<=${WORST_PRESET_SCORE_HARD_LIMIT.toFixed(
      2
    )}.`
  );
  lines.push(
    `3. Noise handling: native_p50 outlier via MADx${OUTLIER_MAD_MULTIPLIER} (or ${(
      OUTLIER_RELATIVE_FALLBACK * 100
    ).toFixed(1)}% fallback), display-vs-overall mismatch threshold ${DISPLAY_VS_OVERALL_GAP_PCT.toFixed(
      1
    )}%, strict drop penalty>=${STRONG_NOISE_PENALTY_THRESHOLD} only when strict_noise=true.`
  );
  lines.push(
    "4. Ranking order: overall_score_p50 asc, worst_preset_score asc, preset_spread asc, noise_penalty asc, delta_vs_anchor_overall_score_p50 desc."
  );
  lines.push(
    "5. Diversity policy: family cap disabled; no forced specialist/contrarian slots."
  );

  return `${lines.join("\n")}\n`;
}

function normalizeForJson(candidate) {
  return {
    snapshot_id: candidate.snapshot_id,
    status: candidate.status,
    parent: candidate.parent,
    branch: candidate.branch,
    family: candidate.family,
    depth: candidate.depth,
    idea: candidate.idea,
    selection_role: candidate.selection_role,
    benchmark_preset: candidate.benchmark_preset,
    overall_score_p50: candidate.overall_score_p50,
    quick_score_p50: candidate.quick_score_p50,
    medium_score_p50: candidate.medium_score_p50,
    balanced_score_p50: candidate.balanced_score_p50,
    worst_preset_score: candidate.worst_preset_score,
    preset_spread: candidate.preset_spread,
    quick_medium_score: candidate.quick_medium_score,
    delta_vs_anchor_overall_score_p50: candidate.delta_vs_anchor_overall_score_p50,
    improvement_vs_native_overall_p50: candidate.improvement_vs_native_overall_p50,
    display_preset_improvement_vs_native_p50: candidate.display_preset_improvement_vs_native_p50,
    noise_flag: candidate.noise_flag,
    noise_penalty: candidate.noise_penalty,
    noise_reasons: candidate.noise_reasons,
  };
}

function buildExcludedReasons(candidate) {
  const reasons = [];
  if (Number(candidate.noise_penalty) > 0) {
    reasons.push(`noise_penalty_${Number(candidate.noise_penalty)}`);
  }
  if (reasons.length === 0) {
    reasons.push("slot_policy");
  }

  return reasons;
}

export async function runShortlistCandidatesCli(argv) {
  const helpProfile = resolveHelpSortingProfile(argv);
  const args = parseArgs(argv);
  if (args.help) {
    printHelp(helpProfile);
    return;
  }
  const profile = resolveActiveSortingProfile(argv);
  args.input = args.input || defaultInputFileForBase(args.baseFile, profile);
  args.outText = args.outText || defaultOutputTextFileForBase(args.baseFile, profile);
  args.outJson = args.outJson || defaultOutputJsonFileForBase(args.baseFile, profile);

  const inputText = await fs.readFile(args.input, "utf8");
  const rawLines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const records = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    try {
      records.push(JSON.parse(rawLines[i]));
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new Error(`Invalid JSONL at line ${i + 1}: ${message}`);
    }
  }

  const snapshotCandidates = [];
  for (let i = 0; i < records.length; i += 1) {
    const candidate = buildCandidateFromRecord(records[i]);
    if (candidate.type === "snapshot") {
      snapshotCandidates.push(candidate);
    }
  }

  const benchmarkValid = snapshotCandidates.filter((entry) => isBenchmarkValidCandidate(entry));

  const nativeP50ByPreset = new Map();
  for (let i = 0; i < benchmarkValid.length; i += 1) {
    const item = benchmarkValid[i];
    if (!Number.isFinite(item.native_p50)) {
      continue;
    }
    const key = item.benchmark_preset || "unknown";
    if (!nativeP50ByPreset.has(key)) {
      nativeP50ByPreset.set(key, []);
    }
    nativeP50ByPreset.get(key).push(item.native_p50);
  }

  const presetStats = new Map();
  for (const [presetId, values] of nativeP50ByPreset.entries()) {
    const med = median(values);
    const deviation = mad(values, med);
    presetStats.set(presetId, {
      median: med,
      mad: deviation,
    });
  }

  const afterFilters = [];
  for (let i = 0; i < benchmarkValid.length; i += 1) {
    const item = benchmarkValid[i];
    const stats = presetStats.get(item.benchmark_preset || "unknown");
    const overallImprovement = item.improvement_vs_native_overall_p50;
    const displayImprovement = item.display_preset_improvement_vs_native_p50;
    let nativeOutlier = false;
    if (stats && Number.isFinite(item.native_p50) && Number.isFinite(stats.median)) {
      if (Number.isFinite(stats.mad) && stats.mad > 0) {
        nativeOutlier = Math.abs(item.native_p50 - stats.median) > OUTLIER_MAD_MULTIPLIER * stats.mad;
      } else if (stats.median > 0) {
        nativeOutlier =
          Math.abs(item.native_p50 - stats.median) / stats.median > OUTLIER_RELATIVE_FALLBACK;
      }
    }

    const displayGap =
      Number.isFinite(displayImprovement) && Number.isFinite(overallImprovement)
        ? displayImprovement - overallImprovement
        : Number.NaN;
    const displayMismatch = Number.isFinite(displayGap) && displayGap > DISPLAY_VS_OVERALL_GAP_PCT;
    const severeDisplayMismatch =
      Number.isFinite(displayImprovement) &&
      Number.isFinite(overallImprovement) &&
      displayImprovement > 8 &&
      overallImprovement < 1;

    let noisePenalty = 0;
    const noiseReasons = [];
    if (nativeOutlier) {
      noisePenalty += 2;
      noiseReasons.push("native_p50_outlier");
    }
    if (displayMismatch) {
      noisePenalty += 1;
      noiseReasons.push("display_vs_overall_gap");
    }
    if (severeDisplayMismatch) {
      noisePenalty += 1;
      noiseReasons.push("display_gain_not_global");
    }

    item.noise_flag = noisePenalty > 0;
    item.noise_penalty = noisePenalty;
    item.noise_reasons = noiseReasons;

    if (Number.isFinite(item.worst_preset_score) && item.worst_preset_score > WORST_PRESET_SCORE_HARD_LIMIT) {
      continue;
    }
    if (!Number.isFinite(item.improvement_vs_native_overall_p50) || item.improvement_vs_native_overall_p50 <= 0) {
      continue;
    }
    if (args.strictNoise && noisePenalty >= STRONG_NOISE_PENALTY_THRESHOLD) {
      continue;
    }

    afterFilters.push(item);
  }

  const shortlistResult = shortlistCandidates(afterFilters, {
    top: args.top,
  });

  const shortlist = shortlistResult.selected.map((entry) => normalizeForJson(entry));
  const shortlistedIdSet = new Set();
  for (let i = 0; i < shortlist.length; i += 1) {
    const item = shortlist[i];
    shortlistedIdSet.add(item.snapshot_id);
  }

  const topOverallRaw = afterFilters
    .slice()
    .sort(compareByOverallScore)
    .slice(0, TOP_OVERALL_DIAGNOSTIC_COUNT);
  const topOverallByScore = topOverallRaw.map((entry) => {
    return {
      snapshot_id: entry.snapshot_id,
      overall_score_p50: entry.overall_score_p50,
    };
  });
  const excludedTopOverall = topOverallRaw
    .filter((entry) => !shortlistedIdSet.has(entry.snapshot_id))
    .map((entry) => {
      const normalized = normalizeForJson(entry);
      normalized.excluded_reasons = buildExcludedReasons(entry);
      return normalized;
    });
  const importantDecisionMetrics = shortlist.map((item) => {
    return {
      snapshot_id: item.snapshot_id,
      overall_score_p50: item.overall_score_p50,
      worst_preset_score: item.worst_preset_score,
      preset_spread: item.preset_spread,
      delta_vs_anchor_overall_score_p50: item.delta_vs_anchor_overall_score_p50,
      improvement_vs_native_overall_p50: item.improvement_vs_native_overall_p50,
    };
  });

  const outputJson = {
    generated_at: new Date().toISOString(),
    input_file: args.input,
    config: {
      top: args.top,
      top_overall_diagnostic_count: TOP_OVERALL_DIAGNOSTIC_COUNT,
      strict_noise: args.strictNoise,
      worst_preset_score_hard_limit: WORST_PRESET_SCORE_HARD_LIMIT,
      strong_noise_penalty_threshold: STRONG_NOISE_PENALTY_THRESHOLD,
      outlier_mad_multiplier: OUTLIER_MAD_MULTIPLIER,
      outlier_relative_fallback: OUTLIER_RELATIVE_FALLBACK,
      display_vs_overall_gap_pct: DISPLAY_VS_OVERALL_GAP_PCT,
    },
    counts: {
      records: records.length,
      snapshots: snapshotCandidates.length,
      benchmark_valid: benchmarkValid.length,
      after_filters: afterFilters.length,
      shortlisted: shortlist.length,
      excluded_top_overall: excludedTopOverall.length,
    },
    top_overall_by_score: topOverallByScore,
    shortlist,
    excluded_top_overall: excludedTopOverall,
    important_decision_metrics: importantDecisionMetrics,
    selection_criteria: {
      hard_filters: [
        "type=snapshot",
        "tests_failed=0",
        "overall_score_p50 and preset_quick/medium/balanced_score_p50 are finite",
        "improvement_vs_native_overall_p50 > 0",
        `worst_preset_score <= ${WORST_PRESET_SCORE_HARD_LIMIT.toFixed(2)}`,
      ],
      noise_policy: {
        outlier_mad_multiplier: OUTLIER_MAD_MULTIPLIER,
        outlier_relative_fallback: OUTLIER_RELATIVE_FALLBACK,
        display_vs_overall_gap_pct: DISPLAY_VS_OVERALL_GAP_PCT,
        strict_noise_penalty_threshold: STRONG_NOISE_PENALTY_THRESHOLD,
      },
      ranking_order: [
        "overall_score_p50 asc",
        "worst_preset_score asc",
        "preset_spread asc",
        "noise_penalty asc",
        "delta_vs_anchor_overall_score_p50 desc",
      ],
      slot_policy: {
        max_per_family: null,
        family_key: "first_3_branch_segments",
        forced_specialist_slots: 0,
        forced_contrarian_slots: 0,
      },
    },
  };

  const textOutput = buildTextOutput(outputJson);

  await fs.mkdir(path.dirname(args.outText), { recursive: true });
  await fs.mkdir(path.dirname(args.outJson), { recursive: true });
  await fs.writeFile(args.outText, textOutput, "utf8");
  await fs.writeFile(args.outJson, `${JSON.stringify(outputJson, null, 2)}\n`, "utf8");

  console.log(`Input: ${args.input}`);
  console.log(
    `Counts: records=${outputJson.counts.records}, snapshots=${outputJson.counts.snapshots}, benchmark_valid=${outputJson.counts.benchmark_valid}, after_filters=${outputJson.counts.after_filters}`
  );
  console.log(`Shortlisted: ${outputJson.counts.shortlisted}`);
  console.log(`Excluded top-overall: ${outputJson.counts.excluded_top_overall}`);
  console.log(`Output text: ${args.outText}`);
  console.log(`Output json: ${args.outJson}`);
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
  runShortlistCandidatesCli(process.argv.slice(2)).catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`shortlist candidates failed: ${message}`);
    process.exitCode = 1;
  });
}

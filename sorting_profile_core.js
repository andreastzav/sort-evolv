import { toPositiveInt } from "./numeric_utils_core.js";

const DEFAULT_SORTING_ID = "sorting";
const DEFAULT_SNAPSHOT_DIGITS = 4;
const DEFAULT_ROOT_PARENT_DIR = "algorithms";

function splitPathSegments(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "");
}

function joinPath(...parts) {
  const segments = [];
  for (let i = 0; i < parts.length; i += 1) {
    const current = splitPathSegments(parts[i]);
    for (let j = 0; j < current.length; j += 1) {
      segments.push(current[j]);
    }
  }
  return segments.join("/");
}

function basenamePath(value) {
  const segments = splitPathSegments(value);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

function toNonEmptyString(value, fallback) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }

  return fallback;
}

function slugify(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || DEFAULT_SORTING_ID;
}

function normalizeSortingId(value) {
  const text = String(value || "").trim();
  if (text === "") {
    return "";
  }

  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureSnapshotPrefix(value, fallback) {
  const text = toNonEmptyString(value, fallback);
  if (text.endsWith("_")) {
    return text;
  }

  return `${text}_`;
}

function buildDefaultSortingProfile(sortingId) {
  const normalizedSortingId = slugify(sortingId);
  const candidateLabel = normalizedSortingId;
  const candidateSlug = slugify(candidateLabel);

  return Object.freeze({
    sortingId: normalizedSortingId,
    rootDir: joinPath(DEFAULT_ROOT_PARENT_DIR, normalizedSortingId),
    evolutionDirName: "evolution",
    snapshotDirName: "snapshots",
    tablesDirName: "tables",
    workingFile: `${normalizedSortingId}.js`,
    baselineFile: `${normalizedSortingId}_original.js`,
    candidateSorterId: normalizedSortingId,
    candidateLabel,
    snapshotPrefix: `${normalizedSortingId}_`,
    snapshotDigits: DEFAULT_SNAPSHOT_DIGITS,
    metadataFileName: `${candidateSlug}_iterations.json`,
    progressLogFileName: `${candidateSlug}_progress.txt`,
    progressJsonlFileName: `${candidateSlug}_progress.jsonl`,
    progressCsvFileName: `${candidateSlug}_progress.csv`,
    graphTitle: `${candidateLabel} evolution`,
    testRunner: Object.freeze({
      type: "module",
      modulePath: "./unit-tests-core.js",
      exportName: "runUnitTestSuite",
      options: Object.freeze({
        stopOnFail: false,
      }),
    }),
  });
}

function normalizeTestRunner(overrides = {}, fallback) {
  const type = toNonEmptyString(overrides.testRunnerType, fallback.type);
  if (type === "command") {
    return Object.freeze({
      type: "command",
      command: toNonEmptyString(overrides.testRunnerCommand, ""),
    });
  }

  return Object.freeze({
    type: "module",
    modulePath: toNonEmptyString(overrides.testRunnerModulePath, fallback.modulePath),
    exportName: toNonEmptyString(overrides.testRunnerExportName, fallback.exportName),
    options:
      overrides.testRunnerOptions && typeof overrides.testRunnerOptions === "object"
        ? { ...overrides.testRunnerOptions }
        : { ...fallback.options },
  });
}

export function resolveSortingProfile(overrides = {}) {
  const base = buildDefaultSortingProfile(
    toNonEmptyString(overrides.sortingId, DEFAULT_SORTING_ID)
  );
  const sortingId = slugify(toNonEmptyString(overrides.sortingId, base.sortingId));
  const rootDir = toNonEmptyString(
    overrides.rootDir,
    joinPath(DEFAULT_ROOT_PARENT_DIR, sortingId)
  );
  const candidateLabel = toNonEmptyString(overrides.candidateLabel, base.candidateLabel);
  const candidateSlug = slugify(candidateLabel);
  const snapshotPrefix = ensureSnapshotPrefix(overrides.snapshotPrefix, base.snapshotPrefix);
  const snapshotDigits = toPositiveInt(overrides.snapshotDigits, base.snapshotDigits);

  return Object.freeze({
    sortingId,
    rootDir,
    evolutionDirName: toNonEmptyString(overrides.evolutionDirName, base.evolutionDirName),
    snapshotDirName: toNonEmptyString(overrides.snapshotDirName, base.snapshotDirName),
    tablesDirName: toNonEmptyString(overrides.tablesDirName, base.tablesDirName),
    workingFile: toNonEmptyString(overrides.workingFile, base.workingFile),
    baselineFile: toNonEmptyString(overrides.baselineFile, base.baselineFile),
    candidateSorterId: toNonEmptyString(overrides.candidateSorterId, base.candidateSorterId),
    candidateLabel,
    snapshotPrefix,
    snapshotDigits,
    metadataFileName: toNonEmptyString(
      overrides.metadataFileName,
      `${candidateSlug}_iterations.json`
    ),
    progressLogFileName: toNonEmptyString(
      overrides.progressLogFileName,
      `${candidateSlug}_progress.txt`
    ),
    progressJsonlFileName: toNonEmptyString(
      overrides.progressJsonlFileName,
      `${candidateSlug}_progress.jsonl`
    ),
    progressCsvFileName: toNonEmptyString(
      overrides.progressCsvFileName,
      `${candidateSlug}_progress.csv`
    ),
    graphTitle: toNonEmptyString(overrides.graphTitle, base.graphTitle),
    testRunner: normalizeTestRunner(overrides, base.testRunner),
  });
}

export function parseSortingIdFromCliArgs(argv) {
  const args = Array.isArray(argv)
    ? argv
    : typeof process !== "undefined" && Array.isArray(process.argv)
      ? process.argv.slice(2)
      : [];

  let resolved = "";
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");

    if (token === "--sorting") {
      const nextToken = String(args[i + 1] || "").trim();
      if (nextToken === "" || nextToken.startsWith("--")) {
        throw new Error("--sorting requires a value.");
      }
      const normalized = normalizeSortingId(nextToken);
      if (normalized === "") {
        throw new Error("--sorting must contain at least one letter or digit.");
      }
      if (resolved !== "") {
        throw new Error("Duplicate --sorting options detected. Pass --sorting exactly once.");
      }
      resolved = normalized;
      i += 1;
      continue;
    }

    if (token.startsWith("--sorting=")) {
      const value = token.slice("--sorting=".length).trim();
      if (value === "") {
        throw new Error("--sorting requires a value.");
      }
      const normalized = normalizeSortingId(value);
      if (normalized === "") {
        throw new Error("--sorting must contain at least one letter or digit.");
      }
      if (resolved !== "") {
        throw new Error("Duplicate --sorting options detected. Pass --sorting exactly once.");
      }
      resolved = normalized;
    }
  }

  return resolved;
}

export function resolveActiveSortingId(argv) {
  const cliSortingId = parseSortingIdFromCliArgs(argv);
  if (cliSortingId !== "") {
    return cliSortingId;
  }

  throw new Error(
    'Missing required global option: --sorting <id>. Example: "--sorting <id>".'
  );
}

export function resolveActiveSortingProfile(argv) {
  return resolveSortingProfile({ sortingId: resolveActiveSortingId(argv) });
}

export function resolveFallbackSortingProfile() {
  return resolveSortingProfile({ sortingId: DEFAULT_SORTING_ID });
}

function baseStemFromFileName(fileName) {
  const text = String(fileName || "").trim();
  if (text.toLowerCase().endsWith(".js")) {
    return text.slice(0, -3);
  }
  return text;
}

export function evolutionRootDirForProfile(profile) {
  return joinPath(profile.rootDir, profile.evolutionDirName);
}

function snapshotRootDirForProfile(profile) {
  return joinPath(profile.rootDir, profile.snapshotDirName);
}

export function tablesRootDirForProfile(profile) {
  return joinPath(profile.rootDir, profile.tablesDirName);
}

export function evolutionDirForBase(baseFile, profile) {
  return joinPath(evolutionRootDirForProfile(profile), baseStemFromFileName(baseFile));
}

export function snapshotDirForBase(baseFile, profile) {
  return joinPath(snapshotRootDirForProfile(profile), baseStemFromFileName(baseFile));
}

export function snapshotFilePattern(profile) {
  const prefix = escapeRegExp(profile.snapshotPrefix);
  const digits = toPositiveInt(profile.snapshotDigits, DEFAULT_SNAPSHOT_DIGITS);
  return new RegExp(`^${prefix}\\d{${digits}}\\.js$`, "i");
}

export function snapshotFileNameFromId(snapshotId, profile) {
  const digits = toPositiveInt(profile.snapshotDigits, DEFAULT_SNAPSHOT_DIGITS);
  const idText = String(snapshotId || "").trim();
  if (!/^\d+$/.test(idText)) {
    throw new Error(`Invalid snapshot id: ${idText}`);
  }
  return `${profile.snapshotPrefix}${idText.padStart(digits, "0")}.js`;
}

export function extractSnapshotIdFromText(value, profile) {
  const digits = toPositiveInt(profile.snapshotDigits, DEFAULT_SNAPSHOT_DIGITS);
  const token = String(value || "").trim();
  if (token === "") {
    return "";
  }

  if (new RegExp(`^\\d{1,${digits}}$`).test(token)) {
    return token.padStart(digits, "0");
  }

  const prefix = escapeRegExp(profile.snapshotPrefix);
  let match = token.match(new RegExp(`^${prefix}(\\d{1,${digits}})$`, "i"));
  if (match) {
    return match[1].padStart(digits, "0");
  }

  match = token.match(new RegExp(`^${prefix}(\\d{1,${digits}})\\.js$`, "i"));
  if (match) {
    return match[1].padStart(digits, "0");
  }

  return "";
}

export function normalizeSnapshotToken(value, profile) {
  const snapshotId = extractSnapshotIdFromText(value, profile);
  if (!snapshotId) {
    return String(value || "").trim();
  }

  return snapshotFileNameFromId(snapshotId, profile);
}

export function extractSnapshotIdFromFilePath(filePath, profile) {
  const baseName = basenamePath(String(filePath || "").trim());
  const prefix = escapeRegExp(profile.snapshotPrefix);
  const digits = toPositiveInt(profile.snapshotDigits, DEFAULT_SNAPSHOT_DIGITS);
  const match = baseName.match(new RegExp(`^${prefix}(\\d{1,${digits}})\\.js$`, "i"));
  if (!match) {
    return "";
  }

  return match[1].padStart(digits, "0");
}

export function resolveBaselineTotals(benchmarkTotals) {
  if (!benchmarkTotals || typeof benchmarkTotals !== "object") {
    return null;
  }

  return benchmarkTotals.baseline && typeof benchmarkTotals.baseline === "object"
    ? benchmarkTotals.baseline
    : null;
}

export function resolveCandidateTotals(benchmarkTotals) {
  if (!benchmarkTotals || typeof benchmarkTotals !== "object") {
    return null;
  }

  return benchmarkTotals.candidate && typeof benchmarkTotals.candidate === "object"
    ? benchmarkTotals.candidate
    : null;
}

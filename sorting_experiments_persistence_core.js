import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { toPositiveInt } from "./cli_arg_utils_core.js";
import { fileExists } from "./fs_utils_core.js";
export { fileExists } from "./fs_utils_core.js";

export async function readFileUtf8(filePath) {
  return fs.readFile(filePath, "utf8");
}

export async function ensureEvolutionDirectory(evolutionDir) {
  await fs.mkdir(evolutionDir, { recursive: true });
}

export function computeSha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function snapshotIdFromNumber(numberValue, snapshotDigits) {
  return String(numberValue).padStart(snapshotDigits, "0");
}

export function snapshotFileFromId(snapshotId, context) {
  return path.join(context.snapshotDir, `${context.snapshotPrefix}${snapshotId}.js`);
}

export async function resolveSnapshotFilePath(filePath, context) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return filePath;
  }

  if (await fileExists(filePath)) {
    return filePath;
  }

  const baseName = path.basename(filePath);
  const looksLikeSnapshot =
    baseName.startsWith(context.snapshotPrefix) && baseName.endsWith(".js");
  if (!looksLikeSnapshot) {
    return filePath;
  }

  const inSnapshotDir = path.join(context.snapshotDir, baseName);
  if (await fileExists(inSnapshotDir)) {
    return inSnapshotDir;
  }

  return filePath;
}

export async function readMetadata(metadataFile) {
  if (!(await fileExists(metadataFile))) {
    return null;
  }

  const raw = await readFileUtf8(metadataFile);
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Metadata file is invalid.");
  }

  return parsed;
}

export async function writeMetadata(context, metadata, nowIso) {
  metadata.updatedAt = nowIso();
  await ensureEvolutionDirectory(context.evolutionDir);
  await fs.writeFile(context.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
}

async function appendProgressCsvRecord(context, reporting, record) {
  if (!record || typeof record !== "object") {
    return;
  }

  const recordKeys = Object.keys(record);
  if (recordKeys.length === 0) {
    return;
  }

  await ensureEvolutionDirectory(context.evolutionDir);

  const fileExistsAlready = await fileExists(context.progressCsvFile);
  if (!fileExistsAlready) {
    const headerLine = recordKeys.join(";");
    const rowLine = recordKeys
      .map((key) => reporting.csvEscape(reporting.formatCsvValue(record[key])))
      .join(";");
    await fs.writeFile(context.progressCsvFile, `${headerLine}\n${rowLine}\n`, "utf8");
    return;
  }

  const existingText = await readFileUtf8(context.progressCsvFile);
  const normalized = existingText.replace(/\r\n/g, "\n");
  const existingLines = normalized.split("\n");
  const existingHeader = existingLines.length > 0 ? existingLines[0].trim() : "";
  let headerKeys = reporting.parseCsvHeaderLine(existingHeader).filter((key) => key !== "");
  if (headerKeys.length === 0) {
    headerKeys = recordKeys.slice();
    const headerLine = headerKeys.join(";");
    const rowLine = headerKeys
      .map((key) => reporting.csvEscape(reporting.formatCsvValue(record[key])))
      .join(";");
    await fs.writeFile(context.progressCsvFile, `${headerLine}\n${rowLine}\n`, "utf8");
    return;
  }

  const missingKeys = [];
  for (let i = 0; i < recordKeys.length; i += 1) {
    const key = recordKeys[i];
    if (!headerKeys.includes(key)) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    const nextHeaderKeys = headerKeys.concat(missingKeys);
    const rewrittenLines = [nextHeaderKeys.join(";")];
    const suffix = ";".repeat(missingKeys.length);
    for (let i = 1; i < existingLines.length; i += 1) {
      const line = existingLines[i];
      if (line.trim() === "") {
        continue;
      }
      rewrittenLines.push(`${line}${suffix}`);
    }
    await fs.writeFile(context.progressCsvFile, `${rewrittenLines.join("\n")}\n`, "utf8");
    headerKeys = nextHeaderKeys;
  }

  const rowLine = headerKeys
    .map((key) => reporting.csvEscape(reporting.formatCsvValue(record[key])))
    .join(";");
  await fs.appendFile(context.progressCsvFile, `${rowLine}\n`, "utf8");
}

export async function appendProgressLog(context, reporting, snapshotRecord) {
  await ensureEvolutionDirectory(context.evolutionDir);
  const jsonRecord = reporting.buildSnapshotProgressRecord(snapshotRecord);
  const entry = reporting.buildProgressLogEntryFromRecord(jsonRecord);
  await fs.appendFile(context.progressLogFile, entry, "utf8");
  await fs.appendFile(context.progressJsonlFile, `${JSON.stringify(jsonRecord)}\n`, "utf8");
  await appendProgressCsvRecord(context, reporting, jsonRecord);
}

export async function appendNonStrategicAttemptLog(context, reporting, details, nowIso) {
  await ensureEvolutionDirectory(context.evolutionDir);
  const createdAt = nowIso();
  const jsonRecord = reporting.buildNonStrategicFailureProgressRecord(details, createdAt);
  const entry = reporting.buildProgressLogEntryFromRecord(jsonRecord);
  await fs.appendFile(context.progressLogFile, entry, "utf8");
  await fs.appendFile(context.progressJsonlFile, `${JSON.stringify(jsonRecord)}\n`, "utf8");
  await appendProgressCsvRecord(context, reporting, jsonRecord);
}

export function createEmptyMetadata(params) {
  const createdAt = params.nowIso();
  return {
    schemaVersion: 1,
    createdAt,
    updatedAt: createdAt,
    files: {
      working: params.workingFile,
      original: params.baseFile,
      snapshots: params.context.snapshotDir,
    },
    constraints: {
      ...params.defaultConstraints,
    },
    root: {
      id: params.rootId,
      file: params.baseFile,
      hash: params.originalHash,
      createdAt,
      status: "winner",
      branchPath: "ROOT",
      progressId: params.rootId,
      parentId: null,
      note: "Immutable baseline snapshot",
    },
    counters: {
      nextSnapshotNumber: 1,
    },
    snapshots: [],
  };
}

export async function ensureInitialized(params) {
  const force = params.force === true;
  const context = params.context;
  await fs.mkdir(context.snapshotDir, { recursive: true });
  await ensureEvolutionDirectory(context.evolutionDir);

  const workingExists = await fileExists(params.workingFile);
  if (!workingExists) {
    throw new Error(`Working file missing: ${params.workingFile}`);
  }

  const baselineExists = await fileExists(params.baseFile);
  if (!baselineExists) {
    throw new Error(
      `Baseline file missing: ${params.baseFile}. Create it in project root or pass --base-file <name>.js.`
    );
  }

  const originalContent = await readFileUtf8(params.baseFile);
  const originalHash = computeSha256(originalContent);
  const existingMetadata = await readMetadata(context.metadataFile);
  if (existingMetadata && !force) {
    if (
      !existingMetadata.root ||
      String(existingMetadata.root.file || "").trim() !== params.baseFile
    ) {
      throw new Error(
        `Metadata/base mismatch in ${context.metadataFile}: expected root.file=${params.baseFile}.`
      );
    }
    console.log(`${context.metadataFile} already exists.`);
    if (!(await fileExists(context.progressLogFile))) {
      await fs.writeFile(
        context.progressLogFile,
        `# ${params.candidateLabel} experiment progress log\n# created ${params.nowIso()}\n\n`,
        "utf8"
      );
      console.log(`Initialized ${context.progressLogFile}.`);
    }
    if (!(await fileExists(context.progressJsonlFile))) {
      await fs.writeFile(context.progressJsonlFile, "", "utf8");
      console.log(`Initialized ${context.progressJsonlFile}.`);
    }
    if (!(await fileExists(context.progressCsvFile))) {
      await fs.writeFile(context.progressCsvFile, "", "utf8");
      console.log(`Initialized ${context.progressCsvFile}.`);
    }
    return existingMetadata;
  }

  const metadata = createEmptyMetadata({
    nowIso: params.nowIso,
    defaultConstraints: params.defaultConstraints,
    rootId: params.rootId,
    workingFile: params.workingFile,
    baseFile: params.baseFile,
    context,
    originalHash,
  });
  await writeMetadata(context, metadata, params.nowIso);
  if (force || !(await fileExists(context.progressLogFile))) {
    await fs.writeFile(
      context.progressLogFile,
      `# ${params.candidateLabel} experiment progress log\n# created ${params.nowIso()}\n\n`,
      "utf8"
    );
  }
  if (force || !(await fileExists(context.progressJsonlFile))) {
    await fs.writeFile(context.progressJsonlFile, "", "utf8");
  }
  if (force || !(await fileExists(context.progressCsvFile))) {
    await fs.writeFile(context.progressCsvFile, "", "utf8");
  }
  console.log(`Initialized metadata in ${context.metadataFile}.`);
  console.log(`Root snapshot: ${params.rootId} (${params.baseFile}).`);
  console.log(`Snapshot directory: ${context.snapshotDir}`);
  console.log(`Progress log: ${context.progressLogFile}`);
  console.log(`Progress log: ${context.progressJsonlFile}`);
  console.log(`Progress log: ${context.progressCsvFile}`);
  return metadata;
}

export async function persistSnapshot(params) {
  const branch = params.resolveBranchForSnapshot(
    params.metadata,
    params.parentSnapshot,
    params.args,
    params.constraints
  );
  const nextNumber = toPositiveInt(params.metadata.counters?.nextSnapshotNumber, 1);
  const snapshotId = snapshotIdFromNumber(nextNumber, params.context.snapshotDigits);
  const snapshotFile = snapshotFileFromId(snapshotId, params.context);

  await fs.mkdir(path.dirname(snapshotFile), { recursive: true });
  await fs.copyFile(params.workingFile, snapshotFile);
  const snapshotContent = await readFileUtf8(snapshotFile);
  const snapshotHash = computeSha256(snapshotContent);

  const snapshotRecord = params.buildSnapshotRecord({
    metadata: params.metadata,
    snapshotId,
    fileName: snapshotFile,
    fileHash: snapshotHash,
    parentSnapshot: params.parentSnapshot,
    branch,
    args: params.args,
    benchmarkTotals: params.benchmarkTotals,
    testSummary: params.testSummary,
  });

  const extra = params.extra || {};
  if (extra && typeof extra.deltaVsParentPct === "number" && Number.isFinite(extra.deltaVsParentPct)) {
    snapshotRecord.deltaVsParentPct = extra.deltaVsParentPct;
    snapshotRecord.deltaVsParentDirection =
      extra.deltaVsParentPct > 0 ? "better" : extra.deltaVsParentPct < 0 ? "worse" : "equal";
  }

  if (extra && typeof extra.anchorId === "string" && extra.anchorId.trim() !== "") {
    snapshotRecord.anchorId = extra.anchorId;
  }

  if (extra && Number.isFinite(extra.anchorScore)) {
    snapshotRecord.anchorScore = Number(extra.anchorScore);
  }

  if (extra && Number.isFinite(extra.deltaVsAnchorPct)) {
    snapshotRecord.deltaVsAnchorPct = Number(extra.deltaVsAnchorPct);
    snapshotRecord.deltaVsAnchorDirection =
      extra.deltaVsAnchorPct > 0 ? "better" : extra.deltaVsAnchorPct < 0 ? "worse" : "equal";
  }

  if (extra && typeof extra.variantRootId === "string" && extra.variantRootId.trim() !== "") {
    snapshotRecord.variantRootId =
      extra.variantRootId === "__SELF__" ? snapshotRecord.id : extra.variantRootId;
  }

  if (extra && Number.isFinite(extra.variantStep)) {
    snapshotRecord.variantStep = Number(extra.variantStep);
  }

  if (extra && Number.isFinite(extra.speculativeLossCount)) {
    snapshotRecord.speculativeLossCount = Number(extra.speculativeLossCount);
  }

  if (extra && extra.decision && typeof extra.decision === "object") {
    snapshotRecord.decision = extra.decision;
  }

  if (extra && extra.benchmarkSuite && typeof extra.benchmarkSuite === "object") {
    snapshotRecord.benchmarkSuite = extra.benchmarkSuite;
  }

  if (extra && Number.isFinite(extra.iterationTotalMs)) {
    snapshotRecord.iterationTotalMs = Number(extra.iterationTotalMs);
  }

  if (extra && Number.isFinite(extra.benchmarkStepTotalMs)) {
    snapshotRecord.benchmarkStepTotalMs = Number(extra.benchmarkStepTotalMs);
  }

  params.metadata.snapshots.push(snapshotRecord);
  params.metadata.counters.nextSnapshotNumber = nextNumber + 1;
  await writeMetadata(params.context, params.metadata, params.nowIso);
  await appendProgressLog(params.context, params.reporting, snapshotRecord);

  return {
    snapshotRecord,
    branch,
  };
}

import { toPositiveInt } from "./numeric_utils_core.js";

export const ROOT_SNAPSHOT_ID = "0000";

function resolveRootId(defaults = {}) {
  const rootId = String(defaults.rootId || ROOT_SNAPSHOT_ID).trim();
  return rootId === "" ? ROOT_SNAPSHOT_ID : rootId;
}

function listSnapshots(metadata) {
  return Array.isArray(metadata?.snapshots) ? metadata.snapshots : [];
}

export function getSnapshotById(metadata, snapshotId, defaults = {}) {
  const rootId = resolveRootId(defaults);
  if (snapshotId === rootId) {
    return metadata?.root || null;
  }

  const snapshots = listSnapshots(metadata);
  for (let i = 0; i < snapshots.length; i += 1) {
    if (snapshots[i]?.id === snapshotId) {
      return snapshots[i];
    }
  }

  return null;
}

export function getLatestSnapshot(metadata) {
  const snapshots = listSnapshots(metadata);
  if (snapshots.length === 0) {
    return metadata?.root || null;
  }

  return snapshots[snapshots.length - 1] || null;
}

function isWinnerOrRoot(snapshot, rootId) {
  return !!snapshot && (snapshot.id === rootId || snapshot.status === "winner");
}

export function resolveAnchorIdForSnapshot(metadata, snapshot, defaults = {}) {
  const rootId = resolveRootId(defaults);
  if (!snapshot) {
    return rootId;
  }

  if (snapshot.id === rootId) {
    return rootId;
  }

  if (snapshot.status === "winner") {
    return snapshot.id;
  }

  if (typeof snapshot.anchorId === "string" && snapshot.anchorId.trim() !== "") {
    const anchor = getSnapshotById(metadata, snapshot.anchorId, defaults);
    if (isWinnerOrRoot(anchor, rootId)) {
      return anchor.id;
    }
  }

  if (typeof snapshot.progressId === "string" && snapshot.progressId.trim() !== "") {
    const progressPoint = getSnapshotById(metadata, snapshot.progressId, defaults);
    if (isWinnerOrRoot(progressPoint, rootId)) {
      return progressPoint.id;
    }
  }

  let cursorId = snapshot.parentId;
  while (typeof cursorId === "string" && cursorId !== "") {
    const cursor = getSnapshotById(metadata, cursorId, defaults);
    if (!cursor) {
      break;
    }

    if (isWinnerOrRoot(cursor, rootId)) {
      return cursor.id;
    }

    cursorId = cursor.parentId;
  }

  return rootId;
}

function getWinnerParentId(metadata, winnerId, defaults = {}) {
  const rootId = resolveRootId(defaults);
  if (winnerId === rootId) {
    return null;
  }

  const winnerSnapshot = getSnapshotById(metadata, winnerId, defaults);
  if (!winnerSnapshot) {
    return null;
  }

  if (
    typeof winnerSnapshot.anchorId === "string" &&
    winnerSnapshot.anchorId.trim() !== "" &&
    winnerSnapshot.anchorId !== winnerSnapshot.id
  ) {
    const anchor = getSnapshotById(metadata, winnerSnapshot.anchorId, defaults);
    if (isWinnerOrRoot(anchor, rootId)) {
      return anchor.id;
    }
  }

  let cursorId = winnerSnapshot.parentId;
  while (typeof cursorId === "string" && cursorId !== "") {
    const cursor = getSnapshotById(metadata, cursorId, defaults);
    if (!cursor) {
      break;
    }

    if (isWinnerOrRoot(cursor, rootId)) {
      return cursor.id;
    }

    cursorId = cursor.parentId;
  }

  return rootId;
}

function buildWinnerBacktrackLineage(metadata, startWinnerId, defaults = {}) {
  const rootId = resolveRootId(defaults);
  const lineage = [];
  const seen = new Set();
  let cursorId = startWinnerId || rootId;

  while (cursorId && !seen.has(cursorId)) {
    seen.add(cursorId);
    const winner = getSnapshotById(metadata, cursorId, defaults);
    if (!winner) {
      break;
    }

    lineage.push(winner);
    if (cursorId === rootId) {
      break;
    }

    cursorId = getWinnerParentId(metadata, cursorId, defaults);
  }

  if (lineage.length === 0 && metadata?.root) {
    lineage.push(metadata.root);
  }

  return lineage;
}

export function getWinnerSlotLimit(constraints, defaults, winnerId) {
  const rootId = resolveRootId(defaults);
  if (winnerId === rootId) {
    return toPositiveInt(
      constraints?.maxRootBranches,
      toPositiveInt(defaults?.maxRootBranchesDefault, 1)
    );
  }

  return toPositiveInt(
    constraints?.maxChildVariantsPerWinner,
    toPositiveInt(defaults?.maxChildVariantsPerWinnerDefault, 1)
  );
}

export function getMaxSpeculativeLosses(constraints, defaults) {
  return toPositiveInt(
    constraints?.maxSpeculativeLosses,
    toPositiveInt(defaults?.maxSpeculativeLossesDefault, 1)
  );
}

function getLocalBeamWidth(constraints, defaults) {
  return toPositiveInt(
    constraints?.localBeamWidth,
    toPositiveInt(defaults?.localBeamWidthDefault, 1)
  );
}

function getMaxChildrenPerLoser(constraints, defaults) {
  return toPositiveInt(
    constraints?.maxChildrenPerLoser,
    toPositiveInt(defaults?.maxChildrenPerLoserDefault, 1)
  );
}

function getMaxUglyContinuationsPerFamily(constraints, defaults) {
  return toPositiveInt(
    constraints?.maxUglyContinuationsPerFamily,
    toPositiveInt(defaults?.maxUglyContinuationsPerFamilyDefault, 0)
  );
}

function collectUsedVariantSlots(metadata, winnerId) {
  const usedSlots = new Set();
  const snapshots = listSnapshots(metadata);
  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i];
    const fromId = snapshot?.branch?.fromId;
    const depth = Number(snapshot?.branch?.depth);
    const slot = Number(snapshot?.branch?.slot);
    if (fromId === winnerId && depth === 1 && Number.isFinite(slot) && slot >= 1) {
      usedSlots.add(slot);
    }
  }

  return usedSlots;
}

function nextAvailableSlotFromUsedSet(usedSlots, slotLimit) {
  for (let slot = 1; slot <= slotLimit; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return null;
}

function formatSlotSegment(prefix, slot) {
  return `${prefix}${String(slot).padStart(2, "0")}`;
}

function buildVariantPath(anchorSnapshot, slot, defaults = {}) {
  const rootId = resolveRootId(defaults);
  if (!anchorSnapshot || anchorSnapshot.id === rootId) {
    return formatSlotSegment("B", slot);
  }

  const basePath = String(anchorSnapshot.branchPath || "").trim();
  if (basePath === "") {
    throw new Error(
      `Cannot allocate variant branch from ${anchorSnapshot.id}: missing branchPath.`
    );
  }

  return `${basePath}.${formatSlotSegment("S", slot)}`;
}

export function getSpeculativeLossCount(metadata, loserSnapshot, anchorId, defaults = {}) {
  const rootId = resolveRootId(defaults);
  if (!loserSnapshot || loserSnapshot.id === rootId || loserSnapshot.status !== "loser") {
    return 0;
  }

  const explicit = Number(loserSnapshot.speculativeLossCount);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  let count = 0;
  let cursor = loserSnapshot;
  while (cursor && cursor.id !== anchorId) {
    if (cursor.status !== "loser") {
      return Number.NaN;
    }

    count += 1;
    if (!cursor.parentId) {
      return Number.NaN;
    }
    cursor = getSnapshotById(metadata, cursor.parentId, defaults);
  }

  if (!cursor || cursor.id !== anchorId) {
    return Number.NaN;
  }

  return count;
}

function numericValue(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : Number.NaN;
}

function getOverallDeltaVsAnchorPct(snapshot) {
  const decisionDelta = numericValue(snapshot?.decision?.overallDeltaVsAnchorPct);
  if (Number.isFinite(decisionDelta)) {
    return decisionDelta;
  }

  return numericValue(snapshot?.deltaVsAnchorPct);
}

function collectPresetDeltas(snapshot) {
  const values = [];
  const fromSuite = Array.isArray(snapshot?.benchmarkSuite?.perPresetDeltaPct)
    ? snapshot.benchmarkSuite.perPresetDeltaPct
    : [];
  for (let i = 0; i < fromSuite.length; i += 1) {
    const delta = numericValue(fromSuite[i]?.deltaPct);
    if (Number.isFinite(delta)) {
      values.push(delta);
    }
  }

  const fromDecisionHits = Array.isArray(snapshot?.decision?.paretoTargetHits)
    ? snapshot.decision.paretoTargetHits
    : [];
  for (let i = 0; i < fromDecisionHits.length; i += 1) {
    const delta = numericValue(fromDecisionHits[i]?.deltaPct);
    if (Number.isFinite(delta)) {
      values.push(delta);
    }
  }

  const fromGuardrailBreaches = Array.isArray(snapshot?.decision?.guardrailBreaches)
    ? snapshot.decision.guardrailBreaches
    : [];
  for (let i = 0; i < fromGuardrailBreaches.length; i += 1) {
    const delta = numericValue(fromGuardrailBreaches[i]?.deltaPct);
    if (Number.isFinite(delta)) {
      values.push(delta);
    }
  }

  return values;
}

function hasNovelIdeaFlag(snapshot) {
  return /\bnovel\s*:/i.test(String(snapshot?.idea || ""));
}

function evaluateLoserForLocalBeam(snapshot, defaults = {}) {
  const overallDeltaPct = getOverallDeltaVsAnchorPct(snapshot);
  const presetDeltas = collectPresetDeltas(snapshot);
  const maxPresetDeltaPct = presetDeltas.length > 0 ? Math.max(...presetDeltas) : Number.NaN;
  const minPresetDeltaPct = presetDeltas.length > 0 ? Math.min(...presetDeltas) : Number.NaN;
  const broadRegression = presetDeltas.length > 0 && presetDeltas.every((delta) => delta < 0);
  const testsFailed = numericValue(snapshot?.tests?.failed);
  const correctnessFailed = Number.isFinite(testsFailed) && testsFailed > 0;
  const guardrailBreaches = Array.isArray(snapshot?.decision?.guardrailBreaches)
    ? snapshot.decision.guardrailBreaches.length
    : 0;
  const guardrailPassed =
    snapshot?.decision?.guardrailPassed === true ||
    (snapshot?.decision && guardrailBreaches === 0);
  const hasNovelFlag = hasNovelIdeaFlag(snapshot);
  const promisingMaxOverallRegressionPct = numericValue(
    defaults?.promisingMaxOverallRegressionPct
  );
  const nicheImprovementPct = numericValue(defaults?.nicheImprovementPct);
  const catastrophicOverallRegressionPct = numericValue(
    defaults?.catastrophicOverallRegressionPct
  );
  const catastrophicPresetRegressionPct = numericValue(
    defaults?.catastrophicPresetRegressionPct
  );
  const closeToAnchor =
    Number.isFinite(overallDeltaPct) &&
    overallDeltaPct >= -Math.abs(Number.isFinite(promisingMaxOverallRegressionPct)
      ? promisingMaxOverallRegressionPct
      : 0);
  const nicheImproved =
    Number.isFinite(maxPresetDeltaPct) &&
    maxPresetDeltaPct >= (Number.isFinite(nicheImprovementPct) ? nicheImprovementPct : 0);
  const catastrophicOverall =
    Number.isFinite(overallDeltaPct) &&
    overallDeltaPct <= (Number.isFinite(catastrophicOverallRegressionPct)
      ? catastrophicOverallRegressionPct
      : -1);
  const catastrophicPreset =
    Number.isFinite(minPresetDeltaPct) &&
    minPresetDeltaPct <= (Number.isFinite(catastrophicPresetRegressionPct)
      ? catastrophicPresetRegressionPct
      : -2);
  const catastrophic = correctnessFailed || catastrophicOverall || catastrophicPreset;
  const promising =
    !correctnessFailed &&
    (
      (guardrailPassed && closeToAnchor) ||
      (!catastrophic && nicheImproved) ||
      (hasNovelFlag && !catastrophic)
    );

  let deadReason = "";
  if (correctnessFailed) {
    deadReason = "correctness failed";
  } else if (catastrophicPreset) {
    deadReason = "strong preset guardrail regression";
  } else if (catastrophicOverall) {
    deadReason = "strong overall regression";
  } else if (broadRegression && !hasNovelFlag) {
    deadReason = "broad regression";
  } else if (!promising) {
    deadReason = "no promising numeric signal";
  }

  return {
    overallDeltaPct,
    maxPresetDeltaPct,
    minPresetDeltaPct,
    guardrailPassed,
    hasNovelFlag,
    promising,
    catastrophic,
    broadRegression,
    deadReason,
  };
}

function resolveLoserFamilyRootId(metadata, loserSnapshot, anchorId, defaults = {}) {
  if (!loserSnapshot || loserSnapshot.status !== "loser") {
    return "";
  }

  if (
    typeof loserSnapshot.variantRootId === "string" &&
    loserSnapshot.variantRootId.trim() !== ""
  ) {
    return loserSnapshot.variantRootId;
  }

  let cursor = loserSnapshot;
  let rootCandidate = loserSnapshot;
  const seen = new Set();
  while (cursor && cursor.id !== anchorId && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    rootCandidate = cursor;
    if (!cursor.parentId) {
      break;
    }
    cursor = getSnapshotById(metadata, cursor.parentId, defaults);
  }

  return rootCandidate?.id || loserSnapshot.id;
}

function collectLoserFamily(metadata, familyRootId) {
  const snapshots = listSnapshots(metadata);
  const family = [];
  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i];
    if (!snapshot || snapshot.status !== "loser") {
      continue;
    }

    const variantRootId =
      typeof snapshot.variantRootId === "string" && snapshot.variantRootId.trim() !== ""
        ? snapshot.variantRootId
        : snapshot.id;
    if (snapshot.id === familyRootId || variantRootId === familyRootId) {
      family.push(snapshot);
    }
  }

  return family;
}

function countChildrenByParentId(metadata, parentId) {
  let count = 0;
  const snapshots = listSnapshots(metadata);
  for (let i = 0; i < snapshots.length; i += 1) {
    if (snapshots[i]?.parentId === parentId) {
      count += 1;
    }
  }

  return count;
}

function countUglyContinuations(family) {
  let count = 0;
  for (let i = 0; i < family.length; i += 1) {
    const selectionKind = String(family[i]?.decision?.usedPlan?.selectionKind || "");
    if (selectionKind === "ugly") {
      count += 1;
    }
  }

  return count;
}

function scoreBeamCandidate(entry, index) {
  const guardrailScore = entry.info.guardrailPassed ? 100000 : 0;
  const overallScore = Number.isFinite(entry.info.overallDeltaPct)
    ? entry.info.overallDeltaPct * 100
    : -100000;
  const nicheScore = Number.isFinite(entry.info.maxPresetDeltaPct)
    ? entry.info.maxPresetDeltaPct * 10
    : 0;
  const childPenalty = entry.childrenUsed * 5;
  return guardrailScore + overallScore + nicheScore - childPenalty + index / 1000;
}

function buildLocalBeamContinuationPlan(
  metadata,
  latest,
  anchorId,
  constraints,
  defaults,
  maxSpeculativeLosses
) {
  const familyRootId = resolveLoserFamilyRootId(metadata, latest, anchorId, defaults);
  const family = collectLoserFamily(metadata, familyRootId);
  const familyLossCount = family.length;
  if (familyLossCount <= 0 || familyLossCount >= maxSpeculativeLosses) {
    return null;
  }

  const localBeamWidth = getLocalBeamWidth(constraints, defaults);
  const maxChildrenPerLoser = getMaxChildrenPerLoser(constraints, defaults);
  const maxUglyContinuations = getMaxUglyContinuationsPerFamily(constraints, defaults);
  const entries = [];
  for (let i = 0; i < family.length; i += 1) {
    const snapshot = family[i];
    const childrenUsed = countChildrenByParentId(metadata, snapshot.id);
    const info = evaluateLoserForLocalBeam(snapshot, defaults);
    const childLimitExhausted = childrenUsed >= maxChildrenPerLoser;
    entries.push({
      snapshot,
      childrenUsed,
      info,
      childLimitExhausted,
      score: 0,
    });
  }

  for (let i = 0; i < entries.length; i += 1) {
    entries[i].score = scoreBeamCandidate(entries[i], i);
  }

  const promising = entries
    .filter((entry) => entry.info.promising && !entry.childLimitExhausted)
    .sort((left, right) => right.score - left.score);
  const beam = promising.slice(0, localBeamWidth);
  const latestEntry = entries.find((entry) => entry.snapshot.id === latest.id) || null;
  let selected = null;
  let selectionKind = "";

  if (
    latestEntry &&
    latestEntry.info.promising &&
    !latestEntry.childLimitExhausted &&
    beam.some((entry) => entry.snapshot.id === latest.id)
  ) {
    selected = latestEntry;
    selectionKind = "latest-promising";
  } else if (beam.length > 0) {
    selected = beam[0];
    selectionKind = "beam-promising";
  } else if (
    latestEntry &&
    !latestEntry.info.catastrophic &&
    !latestEntry.childLimitExhausted &&
    countUglyContinuations(family) < maxUglyContinuations
  ) {
    selected = latestEntry;
    selectionKind = "ugly";
  } else if (latestEntry && !latestEntry.childLimitExhausted) {
    selected = latestEntry;
    selectionKind = "strict-fallback";
  }

  if (!selected) {
    return null;
  }

  return {
    found: true,
    parentId: selected.snapshot.id,
    newBranch: false,
    newVariant: false,
    anchorId,
    progressPointId: anchorId,
    branchPath: selected.snapshot.branchPath || null,
    parentDepth: Number(selected.snapshot.branch?.depth || 0),
    slot: Number(selected.snapshot.branch?.slot || 0),
    speculativeLossCount: familyLossCount,
    familyRootId,
    localBeam: {
      selectionKind,
      localBeamWidth,
      maxChildrenPerLoser,
      maxUglyContinuationsPerFamily: maxUglyContinuations,
      childrenUsed: selected.childrenUsed,
      promisingParents: beam.map((entry) => entry.snapshot.id),
      latestId: latest.id,
      selectedInfo: selected.info,
    },
    reason:
      selectionKind === "latest-promising"
        ? `continue promising loser ${selected.snapshot.id} in local beam (${familyLossCount}/${maxSpeculativeLosses} family losses)`
        : selectionKind === "beam-promising"
          ? `branch from best local-beam loser ${selected.snapshot.id} (${familyLossCount}/${maxSpeculativeLosses} family losses)`
          : selectionKind === "ugly"
            ? `allow ugly continuation from ${selected.snapshot.id} (${familyLossCount}/${maxSpeculativeLosses} family losses)`
            : `strict fallback continuation from ${selected.snapshot.id} (${familyLossCount}/${maxSpeculativeLosses} family losses)`,
  };
}

export function buildNextWorkPlan(metadata, constraints = {}, defaults = {}) {
  const rootId = resolveRootId(defaults);
  const latest = getLatestSnapshot(metadata);
  const maxSpeculativeLosses = getMaxSpeculativeLosses(constraints, defaults);

  if (latest && latest.id !== rootId && latest.status === "loser") {
    const anchorId = resolveAnchorIdForSnapshot(metadata, latest, defaults);
    const localBeamPlan = buildLocalBeamContinuationPlan(
      metadata,
      latest,
      anchorId,
      constraints,
      defaults,
      maxSpeculativeLosses
    );
    if (localBeamPlan) {
      return localBeamPlan;
    }
  }

  const currentAnchorId =
    latest && latest.id !== rootId
      ? resolveAnchorIdForSnapshot(metadata, latest, defaults)
      : rootId;
  const lineage = buildWinnerBacktrackLineage(metadata, currentAnchorId, defaults);

  for (let i = 0; i < lineage.length; i += 1) {
    const winner = lineage[i];
    const winnerId = winner.id;
    const maxVariants = getWinnerSlotLimit(constraints, defaults, winnerId);
    const usedSlots = collectUsedVariantSlots(metadata, winnerId);
    const usedVariants = usedSlots.size;
    if (usedVariants < maxVariants) {
      const slot = nextAvailableSlotFromUsedSet(usedSlots, maxVariants);
      if (slot === null) {
        continue;
      }

      return {
        found: true,
        parentId: winnerId,
        newBranch: true,
        newVariant: true,
        anchorId: winnerId,
        progressPointId: winnerId,
        branchPath: buildVariantPath(winner, slot, defaults),
        parentDepth: Number(winner.branch?.depth || 0),
        slot,
        speculativeLossCount: 0,
        reason: `start sibling variant from anchor ${winnerId} (${usedVariants}/${maxVariants} used)`,
      };
    }
  }

  return {
    found: false,
    parentId: null,
    newBranch: false,
    newVariant: false,
    anchorId: null,
    progressPointId: null,
    branchPath: null,
    parentDepth: 0,
    slot: 0,
    speculativeLossCount: 0,
    reason: "all anchors exhausted (no remaining variant slots from root or any backtracked winner).",
  };
}

export function resolveBranchForSnapshot(
  metadata,
  parentSnapshot,
  args = {},
  constraints = {},
  defaults = {}
) {
  const rootId = resolveRootId(defaults);
  if (!parentSnapshot || typeof parentSnapshot !== "object") {
    throw new Error("Parent snapshot is required to resolve branch metadata.");
  }

  const isFreshVariantStart =
    parentSnapshot.id === rootId ||
    parentSnapshot.status === "winner" ||
    args.newBranch === true;

  if (isFreshVariantStart) {
    let fromSnapshot = parentSnapshot;
    if (args.newBranch === true && parentSnapshot.status === "loser") {
      const resolvedAnchorId =
        typeof args.anchorId === "string" && args.anchorId.trim() !== ""
          ? args.anchorId
          : resolveAnchorIdForSnapshot(metadata, parentSnapshot, defaults);
      const resolvedAnchorSnapshot = getSnapshotById(metadata, resolvedAnchorId, defaults);
      if (!resolvedAnchorSnapshot) {
        throw new Error(`Failed to resolve anchor snapshot: ${resolvedAnchorId}`);
      }
      fromSnapshot = resolvedAnchorSnapshot;
    }

    const maxBranches = getWinnerSlotLimit(constraints, defaults, fromSnapshot.id);
    const usedSlots = collectUsedVariantSlots(metadata, fromSnapshot.id);
    const slot = nextAvailableSlotFromUsedSet(usedSlots, maxBranches);
    if (!Number.isFinite(slot) || slot < 1) {
      const scopeText =
        fromSnapshot.id === rootId
          ? `initial branches from ${rootId}`
          : `sub-branches from progress point ${fromSnapshot.id}`;
      throw new Error(`Branch limit reached for ${scopeText} (max ${maxBranches}).`);
    }

    return {
      fromId: fromSnapshot.id,
      path: buildVariantPath(fromSnapshot, slot, defaults),
      depth: 1,
      slot,
    };
  }

  const depth = Number(parentSnapshot.branch?.depth || 0) + 1;
  const continuedPath = parentSnapshot.branch?.path || parentSnapshot.branchPath;
  if (typeof continuedPath !== "string" || continuedPath.trim() === "") {
    throw new Error(
      `Cannot continue variant from ${parentSnapshot.id}: missing branch path metadata.`
    );
  }

  return {
    fromId:
      parentSnapshot.branch?.fromId ||
      resolveAnchorIdForSnapshot(metadata, parentSnapshot, defaults),
    path: continuedPath,
    depth,
    slot: Number(parentSnapshot.branch?.slot || 0),
  };
}

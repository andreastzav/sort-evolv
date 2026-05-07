import {
  buildNextWorkPlan as buildPlannerNextWorkPlan,
  getMaxSpeculativeLosses as getPlannerMaxSpeculativeLosses,
  getSpeculativeLossCount as getPlannerSpeculativeLossCount,
  getWinnerSlotLimit as getPlannerWinnerSlotLimit,
  resolveAnchorIdForSnapshot as resolvePlannerAnchorIdForSnapshot,
  resolveBranchForSnapshot as resolvePlannerBranchForSnapshot,
} from "./orchestrator_planner_core.js";

export function getSnapshotById(metadata, snapshotId, rootId) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  if (snapshotId === rootId) {
    return metadata.root || null;
  }
  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  for (let i = 0; i < snapshots.length; i += 1) {
    if (snapshots[i] && snapshots[i].id === snapshotId) {
      return snapshots[i];
    }
  }
  return null;
}

export function getLatestSnapshot(metadata, rootId) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  if (snapshots.length === 0) {
    return getSnapshotById(metadata, rootId, rootId);
  }
  return snapshots[snapshots.length - 1] || null;
}

export function getWinnerSlotLimit(constraints, winnerId, plannerDefaults) {
  return getPlannerWinnerSlotLimit(constraints, plannerDefaults, winnerId);
}

export function getMaxSpeculativeLosses(constraints, plannerDefaults) {
  return getPlannerMaxSpeculativeLosses(constraints, plannerDefaults);
}

export function resolveAnchorIdForSnapshot(metadata, snapshot, plannerDefaults) {
  return resolvePlannerAnchorIdForSnapshot(metadata, snapshot, plannerDefaults);
}

export function getSpeculativeLossCount(metadata, loserSnapshot, anchorId, plannerDefaults) {
  return getPlannerSpeculativeLossCount(metadata, loserSnapshot, anchorId, plannerDefaults);
}

export function buildNextWorkPlan(metadata, constraints, plannerDefaults) {
  return buildPlannerNextWorkPlan(metadata, constraints, plannerDefaults);
}

export function resolveBranchForSnapshot(
  metadata,
  parentSnapshot,
  args,
  constraints,
  plannerDefaults
) {
  return resolvePlannerBranchForSnapshot(
    metadata,
    parentSnapshot,
    {
      newBranch: args?.newBranch === true,
      anchorId: resolveAnchorIdForSnapshot(metadata, parentSnapshot, plannerDefaults),
    },
    constraints,
    plannerDefaults
  );
}

export function formatPlan(plan) {
  const branchText = plan.branchPath ? `branch ${plan.branchPath}` : "new branch";
  const anchorText = plan.anchorId ? `anchor=${plan.anchorId}` : "anchor=n/a";
  const beamText = plan.localBeam?.selectionKind
    ? `; local-beam=${plan.localBeam.selectionKind}`
    : "";
  return `${plan.reason}; parent=${plan.parentId}; ${anchorText}; ${branchText}${beamText}`;
}

export function resolveAnchorSnapshotForAutoRecord(
  metadata,
  parentSnapshot,
  args,
  plan,
  plannerDefaults,
  rootId
) {
  if (plan && typeof plan.anchorId === "string" && plan.anchorId !== "") {
    const fromPlan = getSnapshotById(metadata, plan.anchorId, rootId);
    if (fromPlan) {
      return fromPlan;
    }
  }

  if (parentSnapshot.status === "winner") {
    return parentSnapshot;
  }

  if (args.newBranch === true) {
    const anchorId = resolveAnchorIdForSnapshot(metadata, parentSnapshot, plannerDefaults);
    return getSnapshotById(metadata, anchorId, rootId) || metadata.root;
  }

  const derivedAnchorId = resolveAnchorIdForSnapshot(metadata, parentSnapshot, plannerDefaults);
  return getSnapshotById(metadata, derivedAnchorId, rootId) || metadata.root;
}

export const ORCHESTRATOR_BRANCH_LIMITS = Object.freeze({
  maxRootBranches: 6,
  maxChildVariantsPerWinner: 3,
  maxSpeculativeLosses: 5,
});

export const ORCHESTRATOR_LOCAL_BEAM_POLICY = Object.freeze({
  localBeamWidth: 2,
  maxChildrenPerLoser: 2,
  maxUglyContinuationsPerFamily: 1,
  promisingMaxOverallRegressionPct: 0.75,
  nicheImprovementPct: 2,
  catastrophicOverallRegressionPct: -1,
  catastrophicPresetRegressionPct: -2,
});

export const ORCHESTRATOR_DECISION_THRESHOLDS = Object.freeze({
  overallWinThresholdPct: 1,
  overallMaxPresetRegressionPct: 0.5,
});

export function createDefaultConstraints() {
  return {
    maxRootBranches: ORCHESTRATOR_BRANCH_LIMITS.maxRootBranches,
    maxChildVariantsPerWinner: ORCHESTRATOR_BRANCH_LIMITS.maxChildVariantsPerWinner,
    maxSpeculativeLosses: ORCHESTRATOR_BRANCH_LIMITS.maxSpeculativeLosses,
    localBeamWidth: ORCHESTRATOR_LOCAL_BEAM_POLICY.localBeamWidth,
    maxChildrenPerLoser: ORCHESTRATOR_LOCAL_BEAM_POLICY.maxChildrenPerLoser,
    maxUglyContinuationsPerFamily:
      ORCHESTRATOR_LOCAL_BEAM_POLICY.maxUglyContinuationsPerFamily,
  };
}

export function createPlannerDefaults(rootId = "0000") {
  const normalizedRootId = String(rootId || "0000").trim() || "0000";
  return {
    rootId: normalizedRootId,
    maxRootBranchesDefault: ORCHESTRATOR_BRANCH_LIMITS.maxRootBranches,
    maxChildVariantsPerWinnerDefault: ORCHESTRATOR_BRANCH_LIMITS.maxChildVariantsPerWinner,
    maxSpeculativeLossesDefault: ORCHESTRATOR_BRANCH_LIMITS.maxSpeculativeLosses,
    localBeamWidthDefault: ORCHESTRATOR_LOCAL_BEAM_POLICY.localBeamWidth,
    maxChildrenPerLoserDefault: ORCHESTRATOR_LOCAL_BEAM_POLICY.maxChildrenPerLoser,
    maxUglyContinuationsPerFamilyDefault:
      ORCHESTRATOR_LOCAL_BEAM_POLICY.maxUglyContinuationsPerFamily,
    promisingMaxOverallRegressionPct:
      ORCHESTRATOR_LOCAL_BEAM_POLICY.promisingMaxOverallRegressionPct,
    nicheImprovementPct: ORCHESTRATOR_LOCAL_BEAM_POLICY.nicheImprovementPct,
    catastrophicOverallRegressionPct:
      ORCHESTRATOR_LOCAL_BEAM_POLICY.catastrophicOverallRegressionPct,
    catastrophicPresetRegressionPct:
      ORCHESTRATOR_LOCAL_BEAM_POLICY.catastrophicPresetRegressionPct,
  };
}

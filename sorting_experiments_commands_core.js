import fs from "node:fs/promises";

function parseCheckoutArgs(argv) {
  const args = {
    snapshotId: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--id") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--id requires a snapshot id.");
      }

      args.snapshotId = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument for checkout: ${token}`);
  }

  return args;
}

export function createSortingExperimentCommandHandlers(resolveContext) {
  async function recordSnapshot(argv) {
    const ctx = resolveContext();
    const args = ctx.parseRecordArgs(argv, {
      defaultBenchmarkPreset: ctx.DEFAULT_BENCHMARK_PRESET,
    });
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      throw new Error(`Missing ${context.metadataFile}. Run init first.`);
    }

    const constraints = {
      ...ctx.DEFAULT_CONSTRAINTS,
      ...(metadata.constraints || {}),
    };

    const parentId = args.parentId || ctx.getLatestSnapshot(metadata, ctx.ROOT_ID).id;
    const parentSnapshot = ctx.getSnapshotById(metadata, parentId, ctx.ROOT_ID);
    if (!parentSnapshot) {
      throw new Error(`Parent snapshot not found: ${parentId}`);
    }

    let benchmarkTotals = null;
    if (!args.skipBenchmark) {
      benchmarkTotals = await ctx.runBenchmarkForSnapshot(args, {
        runtimeProfile: ctx.runtimeProfile,
        candidateLabel: ctx.CANDIDATE_LABEL,
        candidateSorterId: ctx.CANDIDATE_SORTER_ID,
        workingFile: ctx.WORKING_FILE,
      });
    }

    let testSummary = null;
    if (!args.skipTests) {
      const tests = await ctx.runConfiguredUnitTestSuite(ctx.runtimeProfile);
      testSummary = ctx.summarizeTestResults(tests);
    }

    const persisted = await ctx.persistSnapshot({
      context,
      reporting: ctx.reporting,
      metadata,
      constraints,
      parentSnapshot,
      args,
      benchmarkTotals,
      testSummary,
      workingFile: ctx.WORKING_FILE,
      nowIso: ctx.nowIso,
      resolveBranchForSnapshot: (metadataValue, parent, recordArgs, constraintsValue) =>
        ctx.resolveBranchForSnapshot(
          metadataValue,
          parent,
          recordArgs,
          constraintsValue,
          ctx.plannerDefaults()
        ),
      buildSnapshotRecord: (params) =>
        ctx.buildSnapshotRecord({
          ...params,
          rootId: ctx.ROOT_ID,
          nowIso: ctx.nowIso,
          candidateMetrics: ctx.reporting.candidateMetrics,
        }),
    });
    const snapshotRecord = persisted.snapshotRecord;

    console.log(`Recorded snapshot ${snapshotRecord.id} -> ${snapshotRecord.file}`);
    console.log(`  status: ${snapshotRecord.status}`);
    console.log(`  parent: ${snapshotRecord.parentId}`);
    console.log(
      `  branch: ${snapshotRecord.branchPath} depth ${snapshotRecord.branch.depth}`
    );
    console.log(`  idea: ${snapshotRecord.idea}`);

    if (snapshotRecord.benchmarkTotals) {
      const totals = snapshotRecord.benchmarkTotals;
      const baseline = ctx.reporting.baselineMetrics(totals);
      const candidate = ctx.reporting.candidateMetrics(totals);
      console.log(
        `  benchmark (${args.benchmarkPreset}): native avg ${Number(baseline?.avgMs).toFixed(2)} ms, ${ctx.CANDIDATE_LABEL} avg ${Number(candidate?.avgMs).toFixed(2)} ms, improvement vs native ${ctx.reporting.formatPct(totals.improvementVsNativePct)}`
      );
      console.log(
        `  delta vs parent: ${snapshotRecord.deltaVsParentDirection} (${ctx.reporting.formatPct(snapshotRecord.deltaVsParentPct)})`
      );
    }

    if (snapshotRecord.tests) {
      console.log(
        `  tests: ${snapshotRecord.tests.passed}/${snapshotRecord.tests.total} passed (${snapshotRecord.tests.totalMs.toFixed(2)} ms)`
      );
    }
  }

  async function printStatus() {
    const ctx = resolveContext();
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      console.log(`No ${context.metadataFile} found. Run init.`);
      return;
    }

    const latest = ctx.getLatestSnapshot(metadata, ctx.ROOT_ID);
    console.log(`Metadata: ${context.metadataFile}`);
    console.log(`Snapshots: ${metadata.snapshots.length}`);
    console.log(`Root baseline: ${metadata.root.file} (id ${metadata.root.id})`);
    console.log(`Latest: ${latest.id} -> ${latest.file || metadata.root.file}`);
    if (latest.id !== ctx.ROOT_ID) {
      console.log(`  status: ${latest.status}`);
      console.log(`  branch: ${latest.branchPath}`);
      console.log(`  parent: ${latest.parentId}`);
      if (latest.benchmarkTotals) {
        const baseline = ctx.reporting.baselineMetrics(latest.benchmarkTotals);
        const candidate = ctx.reporting.candidateMetrics(latest.benchmarkTotals);
        console.log(
          `  totals: native ${Number(baseline?.avgMs).toFixed(2)} ms, ${ctx.CANDIDATE_LABEL} ${Number(candidate?.avgMs).toFixed(2)} ms`
        );
      }
    }
  }

  async function listSnapshots(argv) {
    const ctx = resolveContext();
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      console.log(`No ${context.metadataFile} found. Run init.`);
      return;
    }

    let limit = metadata.snapshots.length;
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "--limit") {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--limit requires a value.");
        }

        limit = ctx.toPositiveInt(value, limit);
        i += 1;
      } else {
        throw new Error(`Unknown argument for list: ${argv[i]}`);
      }
    }

    const startIndex = Math.max(0, metadata.snapshots.length - limit);
    for (let i = startIndex; i < metadata.snapshots.length; i += 1) {
      const item = metadata.snapshots[i];
      const baseline = ctx.reporting.baselineMetrics(item.benchmarkTotals);
      const candidate = ctx.reporting.candidateMetrics(item.benchmarkTotals);
      const benchText = item.benchmarkTotals
        ? `native ${Number(baseline?.avgMs).toFixed(2)} / ${ctx.CANDIDATE_LABEL} ${Number(candidate?.avgMs).toFixed(2)} ms`
        : "no benchmark";
      console.log(
        `${item.id} ${item.status.toUpperCase()} ${item.branchPath} parent:${item.parentId} ${benchText} idea:${item.idea}`
      );
    }
  }

  async function checkoutSnapshot(argv) {
    const ctx = resolveContext();
    const args = parseCheckoutArgs(argv);
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      throw new Error(`Missing ${context.metadataFile}. Run init first.`);
    }

    const snapshotId = args.snapshotId || ctx.getLatestSnapshot(metadata, ctx.ROOT_ID).id;
    const snapshot = ctx.getSnapshotById(metadata, snapshotId, ctx.ROOT_ID);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const sourceFileRaw = snapshot.id === ctx.ROOT_ID ? metadata.root.file : snapshot.file;
    const sourceFile = await ctx.resolveSnapshotFilePath(sourceFileRaw, context);
    if (!(await ctx.fileExists(sourceFile))) {
      throw new Error(`Snapshot file missing: ${sourceFileRaw}`);
    }

    await fs.copyFile(sourceFile, ctx.WORKING_FILE);
    console.log(`Checked out snapshot ${snapshot.id} from ${sourceFile} -> ${ctx.WORKING_FILE}`);
  }

  async function printNextPlan(prepareWorkingFile) {
    const ctx = resolveContext();
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      throw new Error(`Missing ${context.metadataFile}. Run init first.`);
    }

    const constraints = {
      ...ctx.DEFAULT_CONSTRAINTS,
      ...(metadata.constraints || {}),
    };
    const plan = ctx.buildNextWorkPlan(metadata, constraints, ctx.plannerDefaults());
    if (!plan.found) {
      console.log(`No next work target: ${plan.reason}`);
      return;
    }

    const parentSnapshot = ctx.getSnapshotById(metadata, plan.parentId, ctx.ROOT_ID);
    if (!parentSnapshot) {
      throw new Error(`Planned parent snapshot is missing: ${plan.parentId}`);
    }

    const sourceFileRaw = parentSnapshot.id === ctx.ROOT_ID ? metadata.root.file : parentSnapshot.file;
    const sourceFile = await ctx.resolveSnapshotFilePath(sourceFileRaw, context);
    if (!sourceFile || !(await ctx.fileExists(sourceFile))) {
      throw new Error(`Planned parent file missing: ${String(sourceFileRaw)}`);
    }

    console.log(`Next target: ${ctx.formatPlan(plan)}`);
    if (prepareWorkingFile) {
      await fs.copyFile(sourceFile, ctx.WORKING_FILE);
      console.log(`Prepared ${ctx.WORKING_FILE} from ${sourceFile}`);
      console.log(
        `Now edit ${ctx.WORKING_FILE}, then run: node sorting_experiments_cli.js --sorting "${ctx.runtimeProfile.sortingId}" --base-file "${ctx.BASE_FILE}" auto-record --idea "<change>"`
      );
    }
  }

  async function autoRecordSnapshot(argv) {
    const ctx = resolveContext();
    const args = ctx.parseAutoRecordArgs(argv, {
      defaultBenchmarkPreset: ctx.DEFAULT_BENCHMARK_PRESET,
      autoDecisionPresetIds: ctx.AUTO_DECISION_PRESET_IDS,
    });
    const iterationStartedMs = Date.now();
    const context = ctx.currentContext();
    const metadata = await ctx.readMetadata(context.metadataFile);
    if (!metadata) {
      throw new Error(`Missing ${context.metadataFile}. Run init first.`);
    }

    const constraints = {
      ...ctx.DEFAULT_CONSTRAINTS,
      ...(metadata.constraints || {}),
    };

    let plan = null;
    if (!args.parentId) {
      plan = ctx.buildNextWorkPlan(metadata, constraints, ctx.plannerDefaults());
      if (!plan.found) {
        throw new Error(`No available plan: ${plan.reason}`);
      }
    }

    const parentId = args.parentId || plan.parentId;
    const parentSnapshot = ctx.getSnapshotById(metadata, parentId, ctx.ROOT_ID);
    if (!parentSnapshot) {
      throw new Error(`Parent snapshot not found: ${parentId}`);
    }
    const inferredNewVariantFromParent =
      parentSnapshot.id === ctx.ROOT_ID || parentSnapshot.status === "winner";
    const newBranch = args.parentId
      ? args.newBranch || inferredNewVariantFromParent
      : plan.newBranch;
    const anchorSnapshot = ctx.resolveAnchorSnapshotForAutoRecord(
      metadata,
      parentSnapshot,
      args,
      plan,
      ctx.plannerDefaults(),
      ctx.ROOT_ID
    );

    console.log(`Step 1/3 syntax check: ${ctx.WORKING_FILE}`);
    const syntaxCheck = await ctx.runNodeSyntaxCheck(ctx.WORKING_FILE);
    if (!syntaxCheck.ok) {
      console.log("  syntax check failed; non-strategic failure (branch budget unchanged)");
      await ctx.appendNonStrategicAttemptLog(
        context,
        ctx.reporting,
        {
          reason: "syntax check failed",
          parentId,
          anchorId: anchorSnapshot.id,
          idea: args.idea,
          syntaxMessage: syntaxCheck.message,
        },
        ctx.nowIso
      );
      const nextPlan = ctx.buildNextWorkPlan(metadata, constraints, ctx.plannerDefaults());
      if (nextPlan.found) {
        console.log(`Next recommended target: ${ctx.formatPlan(nextPlan)}`);
      } else {
        console.log(`No further target: ${nextPlan.reason}`);
      }
      return;
    }
    console.log("  syntax check passed");

    console.log(`Step 2/3 unit tests${args.skipTests ? " (explicitly skipped)" : ""}`);
    let testSummary = null;
    if (!args.skipTests) {
      const tests = await ctx.runConfiguredUnitTestSuite(ctx.runtimeProfile);
      testSummary = ctx.summarizeTestResults(tests);
      console.log(
        `  tests: ${testSummary.passed}/${testSummary.total} passed, ${testSummary.failed} failed (${testSummary.totalMs.toFixed(2)} ms)`
      );
    } else {
      console.log("  unit tests skipped by explicit flag");
    }

    if (testSummary && testSummary.failed > 0) {
      console.log("  unit tests failed; non-strategic failure (branch budget unchanged)");
      await ctx.appendNonStrategicAttemptLog(
        context,
        ctx.reporting,
        {
          reason: "unit tests failed",
          parentId,
          anchorId: anchorSnapshot.id,
          idea: args.idea,
          tests: testSummary,
        },
        ctx.nowIso
      );

      const nextPlan = ctx.buildNextWorkPlan(metadata, constraints, ctx.plannerDefaults());
      if (nextPlan.found) {
        console.log(`Next recommended target: ${ctx.formatPlan(nextPlan)}`);
      } else {
        console.log(`No further target: ${nextPlan.reason}`);
      }
      return;
    }

    console.log("Step 3/3 benchmark");
    if (!args.skipTests) {
      console.log("  unit tests passed, proceeding to benchmark");
    }
    console.log(
      `  flow: shared preset session (native+anchor+candidate), order=${ctx.AUTO_DECISION_ORDER_MODE}, AB_TESTING=${ctx.AUTO_DECISION_AB_TESTING ? "on" : "off"}`
    );

    const benchmarkStepStartedMs = Date.now();
    const decisionBenchmarkSuite = await ctx.runSharedDecisionBenchmarkSuite({
      metadata,
      anchorSnapshot,
      args,
      workingFile: ctx.WORKING_FILE,
      rootId: ctx.ROOT_ID,
      resolveSnapshotFilePath: (filePath) => ctx.resolveSnapshotFilePath(filePath, context),
      fileExists: ctx.fileExists,
      settings: {
        presetIds: ctx.AUTO_DECISION_PRESET_IDS,
        directions: ctx.AUTO_DECISION_DIRECTIONS,
        orderMode: ctx.AUTO_DECISION_ORDER_MODE,
        abTesting: ctx.AUTO_DECISION_AB_TESTING,
        warmupRunsPerCombination: ctx.AUTO_DECISION_WARMUP_RUNS_PER_COMBINATION,
        storeRawRuns: ctx.AUTO_DECISION_STORE_RAW_RUN_VALUES,
      },
    });
    const currentSuiteTotalsByPreset = decisionBenchmarkSuite.currentTotalsByPreset;
    const anchorSuiteTotalsByPreset = decisionBenchmarkSuite.anchorTotalsByPreset;
    const benchmarkStepTotalMs = Date.now() - benchmarkStepStartedMs;
    const decision = ctx.decideAutoStatus({
      anchorSuiteTotalsByPreset,
      currentSuiteTotalsByPreset,
      testSummary,
      settings: {
        presetIds: ctx.AUTO_DECISION_PRESET_IDS,
        mode: ctx.AUTO_DECISION_MODE,
        paretoTargetPresetIds: ctx.AUTO_DECISION_PARETO_TARGET_PRESET_IDS,
        paretoMinTargetImprovementPct: ctx.AUTO_DECISION_PARETO_MIN_TARGET_IMPROVEMENT_PCT,
        paretoMaxPresetRegressionPct: ctx.AUTO_DECISION_PARETO_MAX_PRESET_REGRESSION_PCT,
        overallWinThresholdPct: ctx.AUTO_DECISION_OVERALL_WIN_THRESHOLD_PCT,
        overallMaxPresetRegressionPct: ctx.AUTO_DECISION_OVERALL_MAX_PRESET_REGRESSION_PCT,
      },
    });
    if (!decision.canCompare) {
      throw new Error("Unable to compare current benchmark with anchor benchmark suite.");
    }

    const displayPresetId = ctx.AUTO_DECISION_PRESET_IDS.includes(args.displayPreset)
      ? args.displayPreset
      : ctx.DEFAULT_BENCHMARK_PRESET;
    const currentTotals = currentSuiteTotalsByPreset[displayPresetId] || null;
    const anchorTotals = anchorSuiteTotalsByPreset[displayPresetId] || null;
    const displayPresetDeltaVsAnchor =
      decision.presetDeltas.find((entry) => entry.presetId === displayPresetId) || null;
    const parentPresetScoreFromMetadata = Number(
      parentSnapshot?.benchmarkSuite?.current?.byPreset?.[displayPresetId]?.score
    );
    const currentPresetScoreFromDecision = Number(displayPresetDeltaVsAnchor?.currentScore);
    const deltaVsParentPresetScoreP50Pct = ctx.computePresetDeltaPct(
      parentPresetScoreFromMetadata,
      currentPresetScoreFromDecision
    );
    const parentBenchmarkTotals = parentSnapshot?.benchmarkTotals || null;
    const parentBenchmarkCandidateMetrics = ctx.reporting.candidateMetrics(parentBenchmarkTotals);
    const parentBenchmarkBaselineMetrics = ctx.reporting.baselineMetrics(parentBenchmarkTotals);
    const anchorBenchmarkCandidateMetrics = ctx.reporting.candidateMetrics(anchorTotals);
    const anchorBenchmarkBaselineMetrics = ctx.reporting.baselineMetrics(anchorTotals);
    const currentBenchmarkCandidateMetrics = ctx.reporting.candidateMetrics(currentTotals);
    const currentBenchmarkBaselineMetrics = ctx.reporting.baselineMetrics(currentTotals);
    const parentOverallScoreFromMetadata = Number(parentSnapshot?.benchmarkSuite?.current?.overallScore);
    const deltaVsParentScorePct = ctx.computePresetDeltaPct(
      parentOverallScoreFromMetadata,
      decision.currentOverallScore
    );
    const currentSuiteBenchmarkTotalMs = Number(decisionBenchmarkSuite.currentSuiteBenchmarkTotalMs);
    const parentSuiteBenchmarkTotalMs = Number(decisionBenchmarkSuite.anchorSuiteBenchmarkTotalMs);
    const combinedSuiteBenchmarkTotalMs = Number(decisionBenchmarkSuite.combinedSuiteBenchmarkTotalMs);
    const maxSpeculativeLosses = ctx.getMaxSpeculativeLosses(constraints, ctx.plannerDefaults());
    const startsNewVariant =
      newBranch === true || parentSnapshot.id === ctx.ROOT_ID || parentSnapshot.status === "winner";
    const inheritedVariantRootId =
      typeof parentSnapshot.variantRootId === "string" && parentSnapshot.variantRootId !== ""
        ? parentSnapshot.variantRootId
        : parentSnapshot.id;
    const parentVariantStep = Number(parentSnapshot.variantStep);
    const plannedFamilyLossCount = Number(plan?.speculativeLossCount);
    const variantStep = startsNewVariant
      ? 1
      : Number.isFinite(plannedFamilyLossCount) && plannedFamilyLossCount >= 0
        ? plannedFamilyLossCount + 1
      : Number.isFinite(parentVariantStep) && parentVariantStep >= 1
        ? parentVariantStep + 1
        : 2;
    const parentSpecLoss = Number(parentSnapshot.speculativeLossCount);
    const fallbackParentSpecLoss = ctx.getSpeculativeLossCount(
      metadata,
      parentSnapshot,
      anchorSnapshot.id,
      ctx.plannerDefaults()
    );
    const baseSpecLoss =
      Number.isFinite(plannedFamilyLossCount) && plannedFamilyLossCount >= 0
        ? plannedFamilyLossCount
        : Number.isFinite(parentSpecLoss)
          ? parentSpecLoss
          : fallbackParentSpecLoss;
    const speculativeLossCount =
      decision.status === "winner"
        ? 0
        : startsNewVariant
          ? 1
          : (Number.isFinite(baseSpecLoss) ? baseSpecLoss : 0) + 1;
    const variantRootId = startsNewVariant ? "__SELF__" : inheritedVariantRootId;
    const snapshotDeltaVsParentPct = Number.isFinite(deltaVsParentScorePct)
      ? deltaVsParentScorePct
      : Number.NaN;

    const persistArgs = {
      idea: args.idea,
      status: decision.status,
      parentId,
      newBranch,
      benchmarkPreset: displayPresetId,
      benchmarkRuns: args.benchmarkRuns,
      skipBenchmark: false,
      skipTests: args.skipTests,
    };

    const persisted = await ctx.persistSnapshot({
      context,
      reporting: ctx.reporting,
      metadata,
      constraints,
      parentSnapshot,
      args: persistArgs,
      benchmarkTotals: currentTotals,
      testSummary,
      workingFile: ctx.WORKING_FILE,
      nowIso: ctx.nowIso,
      resolveBranchForSnapshot: (metadataValue, parent, recordArgs, constraintsValue) =>
        ctx.resolveBranchForSnapshot(
          metadataValue,
          parent,
          recordArgs,
          constraintsValue,
          ctx.plannerDefaults()
        ),
      buildSnapshotRecord: (params) =>
        ctx.buildSnapshotRecord({
          ...params,
          rootId: ctx.ROOT_ID,
          nowIso: ctx.nowIso,
          candidateMetrics: ctx.reporting.candidateMetrics,
        }),
      extra: {
        deltaVsParentPct: snapshotDeltaVsParentPct,
        anchorId: anchorSnapshot.id,
        anchorScore: decision.parentOverallScore,
        deltaVsAnchorPct: decision.improvementPct,
        variantRootId,
        variantStep,
        speculativeLossCount,
        benchmarkSuite: {
          presetIds: ctx.AUTO_DECISION_PRESET_IDS.slice(),
          benchmarkFlow: decisionBenchmarkSuite.benchmarkFlow,
          orderMode: decisionBenchmarkSuite.orderMode,
          abTestingEnabled: decisionBenchmarkSuite.abTestingEnabled,
          warmupEnabled: ctx.DECISION_USE_WARMUP,
          warmupRunsPerCombination: ctx.AUTO_DECISION_WARMUP_RUNS_PER_COMBINATION,
          suiteWarmupTotalMs: Number(decisionBenchmarkSuite.suiteWarmupTotalMs),
          primaryMetric: decision.primaryMetric,
          thresholdImprovementPct: decision.thresholdImprovementPct,
          guardrailMaxRegressionPct: decision.guardrailMaxRegressionPct,
          parent: decision.parentSuite,
          current: decision.currentSuite,
          overallDeltaVsAnchorPct: decision.improvementPct,
          overallDeltaVsParentPct: deltaVsParentScorePct,
          anchorId: anchorSnapshot.id,
          parentId: parentSnapshot.id,
          deltaVsImmediateParentPct: deltaVsParentScorePct,
          perPresetDeltaPct: decision.presetDeltas,
          currentSuiteBenchmarkTotalMs,
          parentSuiteBenchmarkTotalMs,
          combinedSuiteBenchmarkTotalMs,
          ...(ctx.AUTO_DECISION_STORE_RAW_RUN_VALUES
            ? { rawRunsByPreset: decisionBenchmarkSuite.rawRunsByPreset }
            : {}),
        },
        decision: {
          mode: "auto",
          rule:
            ctx.AUTO_DECISION_MODE === "pareto"
              ? `syntax check -> unit tests -> shared preset sessions (native+anchor+candidate) with ${ctx.AUTO_DECISION_ORDER_MODE} order; AB_TESTING=${
                ctx.AUTO_DECISION_AB_TESTING ? "on" : "off"
              }; Pareto winner if >=1 target preset improves by threshold and all presets satisfy regression guardrail`
              : `syntax check -> unit tests -> shared preset sessions (native+anchor+candidate) with ${ctx.AUTO_DECISION_ORDER_MODE} order; AB_TESTING=${
                ctx.AUTO_DECISION_AB_TESTING ? "on" : "off"
              }; winner if overall geomean score p50 improves by threshold and guardrail passes`,
          decisionMode: decision.decisionMode,
          primaryMetric: decision.primaryMetric,
          thresholdImprovementPct: decision.thresholdImprovementPct,
          guardrailMaxRegressionPct: decision.guardrailMaxRegressionPct,
          syntaxCheckPassed: true,
          anchorId: anchorSnapshot.id,
          parentOverallScore: decision.parentOverallScore,
          currentOverallScore: decision.currentOverallScore,
          overallDeltaVsAnchorPct: decision.improvementPct,
          overallDeltaVsParentPct: deltaVsParentScorePct,
          decisionPassed: decision.decisionPassed,
          overallPassed: decision.overallPassed,
          paretoTargetPassed: decision.paretoTargetPassed,
          paretoTargetHits: decision.paretoTargetHits,
          paretoTargetPresetIds: decision.paretoTargetPresetIds,
          guardrailPassed: decision.guardrailPassed,
          guardrailBreaches: decision.guardrailBreaches,
          displayPresetId,
          anchorPresetScoreP50: Number(displayPresetDeltaVsAnchor?.parentScore),
          parentPresetScoreP50: parentPresetScoreFromMetadata,
          currentPresetScoreP50: currentPresetScoreFromDecision,
          deltaVsAnchorPresetScoreP50Pct: Number(displayPresetDeltaVsAnchor?.deltaPct),
          deltaVsParentPresetScoreP50Pct: deltaVsParentPresetScoreP50Pct,
          parentBenchmarkCandidateAvgMs: Number(parentBenchmarkCandidateMetrics?.avgMs),
          currentBenchmarkCandidateAvgMs: Number(currentBenchmarkCandidateMetrics?.avgMs),
          anchorBenchmarkCandidateAvgMs: Number(anchorBenchmarkCandidateMetrics?.avgMs),
          parentBenchmarkBaselineAvgMs: Number(parentBenchmarkBaselineMetrics?.avgMs),
          currentBenchmarkBaselineAvgMs: Number(currentBenchmarkBaselineMetrics?.avgMs),
          anchorBenchmarkBaselineAvgMs: Number(anchorBenchmarkBaselineMetrics?.avgMs),
          parentBenchmarkNativeAvgMs: Number(parentBenchmarkBaselineMetrics?.avgMs),
          currentBenchmarkNativeAvgMs: Number(currentBenchmarkBaselineMetrics?.avgMs),
          anchorBenchmarkNativeAvgMs: Number(anchorBenchmarkBaselineMetrics?.avgMs),
          maxSpeculativeLosses,
          testsFailed: decision.testsFailed,
          usedPlan: plan
            ? {
                reason: plan.reason,
                selectionKind: plan.localBeam?.selectionKind || (plan.newVariant ? "new-variant" : "strict"),
                progressPointId: plan.progressPointId,
                selectedParentId: plan.parentId,
                branchPath: plan.branchPath,
                parentDepth: plan.parentDepth,
                familyRootId: plan.familyRootId || null,
                speculativeLossCount: Number.isFinite(Number(plan.speculativeLossCount))
                  ? Number(plan.speculativeLossCount)
                  : null,
                localBeam: plan.localBeam || null,
              }
            : null,
        },
        benchmarkStepTotalMs,
        iterationTotalMs: Date.now() - iterationStartedMs,
      },
    });

    const snapshotRecord = persisted.snapshotRecord;
    console.log(`Auto-recorded snapshot ${snapshotRecord.id} -> ${snapshotRecord.file}`);
    console.log(`  status: ${snapshotRecord.status}`);
    console.log(`  parent: ${snapshotRecord.parentId}`);
    console.log(
      `  branch: ${snapshotRecord.branchPath} depth ${snapshotRecord.branch.depth}, losses ${speculativeLossCount}/${maxSpeculativeLosses}`
    );
    console.log(`  idea: ${snapshotRecord.idea}`);
    if (plan) {
      console.log(`  planned from orchestrator: ${ctx.formatPlan(plan)}`);
    }
    console.log(
      `  decision metric (${decision.primaryMetric}): threshold ${decision.thresholdImprovementPct.toFixed(
        2
      )}%, guardrail -${decision.guardrailMaxRegressionPct.toFixed(2)}%`
    );
    if (decision.decisionMode === "pareto") {
      console.log(
        `  pareto: target presets ${decision.paretoTargetPresetIds.join(",")} -> hit ${
          decision.paretoTargetHits.length
        }/${decision.paretoTargetPresetIds.length} (need >=1)`
      );
    }
    console.log(
      `  overall telemetry: score anchor ${ctx.reporting.formatScore(
        decision.parentOverallScore
      )} -> current ${ctx.reporting.formatScore(decision.currentOverallScore)} (delta ${ctx.reporting.formatPct(
        decision.improvementPct
      )})`
    );
    console.log(
      `  telemetry: overall improvement vs native current ${ctx.reporting.formatPct(
        ctx.reporting.scoreToImprovementVsNativePct(decision.currentOverallScore)
      )}, anchor ${ctx.reporting.formatPct(ctx.reporting.scoreToImprovementVsNativePct(decision.parentOverallScore))}`
    );
    if (Number.isFinite(deltaVsParentScorePct)) {
      console.log(
        `  telemetry: overall delta vs immediate parent ${ctx.reporting.formatPct(deltaVsParentScorePct)}`
      );
    }
    console.log(
      `  guardrail: max preset regression ${decision.guardrailMaxRegressionPct.toFixed(
        2
      )}% -> ${decision.guardrailPassed ? "pass" : "fail"}`
    );
    for (let i = 0; i < decision.presetDeltas.length; i += 1) {
      const presetDelta = decision.presetDeltas[i];
      console.log(
        `  preset ${presetDelta.presetId}: score parent ${ctx.reporting.formatScore(
          presetDelta.parentScore
        )} -> current ${ctx.reporting.formatScore(presetDelta.currentScore)} (delta ${ctx.reporting.formatPct(
          presetDelta.deltaPct
        )})`
      );
    }
    if (currentTotals && anchorTotals) {
      const currentBaseline = ctx.reporting.baselineMetrics(currentTotals);
      const currentCandidate = ctx.reporting.candidateMetrics(currentTotals);
      console.log(
        `  ${displayPresetId} raw: native avg ${ctx.reporting.formatMs(
          currentBaseline?.avgMs
        )}, native p50 ${ctx.reporting.formatMs(currentBaseline?.p50Ms)}, ${ctx.CANDIDATE_LABEL} avg ${ctx.reporting.formatMs(
          currentCandidate?.avgMs
        )}, ${ctx.CANDIDATE_LABEL} p50 ${ctx.reporting.formatMs(currentCandidate?.p50Ms)}`
      );
      console.log(
        `  ${displayPresetId} normalized: score ${ctx.reporting.formatScore(
          Number(currentTotals.comparison?.geomeanScoreP50)
        )}, vs native ${ctx.reporting.formatPct(Number(currentTotals.comparison?.geomeanImprovementP50Pct))}, anchor score ${ctx.reporting.formatScore(
          Number(anchorTotals.comparison?.geomeanScoreP50)
        )}, delta vs anchor score ${ctx.reporting.formatPct(Number(displayPresetDeltaVsAnchor?.deltaPct))}`
      );
    }
    console.log(
      `  benchmark step total: ${ctx.reporting.formatDuration(benchmarkStepTotalMs)} (current suite ${ctx.reporting.formatDuration(
        currentSuiteBenchmarkTotalMs
      )}, parent suite ${ctx.reporting.formatDuration(parentSuiteBenchmarkTotalMs)})`
    );
    console.log(`  iteration total: ${ctx.reporting.formatDuration(Date.now() - iterationStartedMs)}`);
    if (testSummary) {
      console.log(
        `  tests: ${testSummary.passed}/${testSummary.total} passed (${testSummary.totalMs.toFixed(2)} ms)`
      );
    } else {
      console.log("  tests: skipped");
    }

    const nextPlan = ctx.buildNextWorkPlan(metadata, constraints, ctx.plannerDefaults());
    if (nextPlan.found) {
      console.log(`Next recommended target: ${ctx.formatPlan(nextPlan)}`);
    } else {
      console.log(`No further target: ${nextPlan.reason}`);
    }
  }

  return {
    recordSnapshot,
    printStatus,
    listSnapshots,
    checkoutSnapshot,
    printNextPlan,
    autoRecordSnapshot,
  };
}

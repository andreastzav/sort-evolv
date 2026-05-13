import { resolveBaselineTotals, resolveCandidateTotals } from "./sorting_profile_core.js";

export function createReportingCore(options = {}) {
  const candidateLogToken =
    String(options.candidateLogToken || "candidate")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "candidate";

  function formatPct(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    return `${value.toFixed(3)}%`;
  }

  function formatMs(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    return `${value.toFixed(3)} ms`;
  }

  function formatDuration(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    return `${value.toFixed(3)} ms (${(value / 1000).toFixed(3)} s)`;
  }

  function formatScore(value) {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    return value.toFixed(6);
  }

  function scoreToImprovementVsNativePct(score) {
    const numeric = Number(score);
    if (!Number.isFinite(numeric)) {
      return Number.NaN;
    }
    return (1 - numeric) * 100;
  }

  function toNumberOrNull(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return numeric;
  }

  function baselineMetrics(benchmarkTotals) {
    return resolveBaselineTotals(benchmarkTotals);
  }

  function candidateMetrics(benchmarkTotals) {
    return resolveCandidateTotals(benchmarkTotals);
  }

  function hasRecordField(record, key) {
    return Object.prototype.hasOwnProperty.call(record, key);
  }

  function recordField(record, key, fallback = "n/a") {
    if (!hasRecordField(record, key)) {
      return fallback;
    }
    const value = record[key];
    if (value === undefined || value === null) {
      return fallback;
    }
    return String(value);
  }

  function csvEscape(value) {
    const text = value === undefined || value === null ? "" : String(value);
    if (!/[";\r\n]/.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }

  function formatCsvValue(value) {
    const text = value === undefined || value === null ? "" : String(value);
    return text.replace(/(^|[^0-9A-Za-z])(-?\d+\.\d+)(?=$|[^0-9A-Za-z])/g, (full, prefix, numeric) => {
      return `${prefix}${numeric.replace(".", ",")}`;
    });
  }

  function parseCsvHeaderLine(line) {
    if (!line) {
      return [];
    }
    return line.split(";");
  }

  function buildSnapshotProgressRecord(snapshotRecord) {
    const record = {
      type: "snapshot",
      created_at: snapshotRecord.createdAt,
      snapshot_id: snapshotRecord.id,
      status: String(snapshotRecord.status || "unknown").toLowerCase(),
      parent: snapshotRecord.parentId || "n/a",
      branch: snapshotRecord.branchPath || "n/a",
      depth: String(snapshotRecord.branch?.depth ?? "n/a"),
      idea: snapshotRecord.idea || "",
    };

    if (snapshotRecord.benchmarkTotals) {
      const totals = snapshotRecord.benchmarkTotals;
      const baseline = baselineMetrics(totals);
      const candidate = candidateMetrics(totals);
      record.benchmark_preset = snapshotRecord.benchmarkPresetId || "n/a";
      record.native_avg = formatMs(baseline?.avgMs);
      record.native_p50 = formatMs(baseline?.p50Ms);
      record[`${candidateLogToken}_avg`] = formatMs(candidate?.avgMs);
      record[`${candidateLogToken}_p50`] = formatMs(candidate?.p50Ms);
      record.delta_vs_historical_immediate_parent_overall_score_p50 = formatPct(
        snapshotRecord.deltaVsParentPct
      );
      record.delta_vs_immediate_parent_overall_score_p50 = formatPct(snapshotRecord.deltaVsParentPct);
      record.display_preset_improvement_vs_native_avg = formatPct(totals.improvementVsNativePct);
      if (totals.comparison) {
        record.preset_score_p50 = formatScore(Number(totals.comparison.geomeanScoreP50));
        record.display_preset_improvement_vs_native_p50 = formatPct(
          Number(totals.comparison.geomeanImprovementP50Pct)
        );
      }
    }

    if (
      typeof snapshotRecord.anchorId === "string" ||
      Number.isFinite(snapshotRecord.anchorScore) ||
      Number.isFinite(snapshotRecord.deltaVsAnchorPct)
    ) {
      record.anchor_id = snapshotRecord.anchorId || "n/a";
      record.anchor_score_p50 = formatScore(Number(snapshotRecord.anchorScore));
      record.delta_vs_anchor_score_p50 = formatPct(Number(snapshotRecord.deltaVsAnchorPct));
    }

    if (snapshotRecord.benchmarkSuite && snapshotRecord.benchmarkSuite.current) {
      const suite = snapshotRecord.benchmarkSuite;
      const suiteDeltaVsAnchor = Number(suite.overallDeltaVsAnchorPct ?? suite.overallDeltaVsParentPct);
      const currentOverallScore = Number(suite.current?.overallScore);
      const anchorOverallScore = Number((suite.anchor ?? suite.parent)?.overallScore);
      const sameSessionImmediateParentDelta = Number(
        suite.overallDeltaVsImmediateParentSameSessionPct
      );
      const currentImprovementVsNativeOverallPct = scoreToImprovementVsNativePct(currentOverallScore);
      const anchorImprovementVsNativeOverallPct = scoreToImprovementVsNativePct(anchorOverallScore);

      record.suite_presets = Array.isArray(suite.presetIds) ? suite.presetIds.join(",") : "n/a";
      record.primary_metric = suite.primaryMetric || "n/a";
      record.benchmark_flow = suite.benchmarkFlow || "n/a";
      record.order_mode = suite.orderMode || "n/a";
      record.ab_testing = suite.abTestingEnabled === true ? "on" : "off";
      record.warmup_enabled = suite.warmupEnabled === true ? "on" : "off";
      record.warmup_runs_per_combination = String(Number(suite.warmupRunsPerCombination));

      const presetDeltas = Array.isArray(suite.perPresetDeltaPct) ? suite.perPresetDeltaPct : [];
      for (let i = 0; i < presetDeltas.length; i += 1) {
        const item = presetDeltas[i];
        const presetId = String(item.presetId || "").trim();
        if (presetId === "") {
          continue;
        }
        record[`preset_${presetId}_score_p50`] = formatScore(Number(item.currentScore));
        record[`anchor_preset_${presetId}_score_p50`] = formatScore(Number(item.parentScore));
        record[`delta_vs_anchor_preset_${presetId}_score_p50`] = formatPct(Number(item.deltaPct));
      }

      record.overall_score_p50 = formatScore(currentOverallScore);
      record.anchor_overall_score_p50 = formatScore(anchorOverallScore);
      record.delta_vs_anchor_overall_score_p50 = formatPct(suiteDeltaVsAnchor);
      if (Number.isFinite(sameSessionImmediateParentDelta)) {
        record.delta_vs_immediate_parent_same_session_overall_score_p50 =
          formatPct(sameSessionImmediateParentDelta);
      }
      record.anchor_improvement_vs_native_overall_p50 = formatPct(anchorImprovementVsNativeOverallPct);
      record.improvement_vs_native_overall_p50 = formatPct(currentImprovementVsNativeOverallPct);

      if (
        Number.isFinite(suite.currentSuiteBenchmarkTotalMs) ||
        Number.isFinite(suite.parentSuiteBenchmarkTotalMs)
      ) {
        record.suite_benchmark_current_total = formatDuration(Number(suite.currentSuiteBenchmarkTotalMs));
        record.suite_benchmark_anchor_total = formatDuration(
          Number(suite.anchorSuiteBenchmarkTotalMs ?? suite.parentSuiteBenchmarkTotalMs)
        );
        record.suite_benchmark_parent_total = formatDuration(Number(suite.parentSuiteBenchmarkTotalMs));
        if (Number.isFinite(Number(suite.immediateParentSuiteBenchmarkTotalMs))) {
          record.suite_benchmark_immediate_parent_total = formatDuration(
            Number(suite.immediateParentSuiteBenchmarkTotalMs)
          );
        }
        record.suite_benchmark_combined_total = formatDuration(Number(suite.combinedSuiteBenchmarkTotalMs));
      }
    }

    if (
      Number.isFinite(snapshotRecord.benchmarkStepTotalMs) ||
      Number.isFinite(snapshotRecord.iterationTotalMs)
    ) {
      record.benchmark_step_total = formatDuration(Number(snapshotRecord.benchmarkStepTotalMs));
      record.iteration_total = formatDuration(Number(snapshotRecord.iterationTotalMs));
    }

    if (snapshotRecord.tests) {
      record.passed = `${snapshotRecord.tests.passed}/${snapshotRecord.tests.total}`;
      record.failed = String(snapshotRecord.tests.failed);
      record.total_ms = formatMs(snapshotRecord.tests.totalMs);
    }

    if (snapshotRecord.decision && snapshotRecord.decision.mode === "auto") {
      const thresholdValue = Number(snapshotRecord.decision.thresholdImprovementPct);
      record.threshold = Number.isFinite(thresholdValue) ? `${thresholdValue.toFixed(2)}%` : "n/a";
      record.tests_failed = String(Number(snapshotRecord.decision.testsFailed));
      const anchorPresetScoreP50 = Number(
        snapshotRecord.decision.anchorPresetScoreP50 ?? snapshotRecord.decision.parentPresetScoreP50
      );
      const currentPresetScoreP50 = Number(snapshotRecord.decision.currentPresetScoreP50);
      const deltaVsAnchorPresetScoreP50Pct = Number(
        snapshotRecord.decision.deltaVsAnchorPresetScoreP50Pct ??
        snapshotRecord.decision.deltaVsParentPresetScoreP50Pct
      );
      if (Number.isFinite(anchorPresetScoreP50) || Number.isFinite(currentPresetScoreP50)) {
        record.anchor_preset_score_p50 = formatScore(anchorPresetScoreP50);
        record.current_preset_score_p50 = formatScore(currentPresetScoreP50);
        record.delta_vs_anchor_preset_score_p50 = formatPct(deltaVsAnchorPresetScoreP50Pct);
      }
    }

    return record;
  }

  function buildNonStrategicFailureProgressRecord(details, createdAt) {
    const record = {
      type: "non_strategic_failure",
      created_at: createdAt,
      reason: details?.reason || "unknown",
      parent: details?.parentId || "n/a",
      anchor: details?.anchorId || "n/a",
    };
    if (details?.idea) {
      record.idea = details.idea;
    }
    if (details?.syntaxMessage) {
      record.syntax_message = details.syntaxMessage;
    }
    if (details?.tests) {
      record.passed = `${details.tests.passed}/${details.tests.total}`;
      record.failed = String(details.tests.failed);
      record.total_ms = formatMs(details.tests.totalMs);
    }
    return record;
  }

  function buildProgressLogEntryFromRecord(record) {
    if (!record || typeof record !== "object") {
      return "";
    }

    const type = String(record.type || "");
    const lines = [];

    if (type === "snapshot") {
      lines.push(
        `[${recordField(record, "created_at")}] snapshot ${recordField(record, "snapshot_id")} (${recordField(
          record,
          "status",
          "unknown"
        ).toUpperCase()})`
      );
      lines.push(
        `parent=${recordField(record, "parent")} branch=${recordField(record, "branch")} depth=${recordField(
          record,
          "depth"
        )} idea=${recordField(record, "idea", "")}`
      );

      if (hasRecordField(record, "benchmark_preset")) {
        lines.push(`benchmark preset=${recordField(record, "benchmark_preset")}`);
        lines.push(
          `native_avg=${recordField(record, "native_avg")} native_p50=${recordField(record, "native_p50")}`
        );
        lines.push(
          `${candidateLogToken}_avg=${recordField(
            record,
            `${candidateLogToken}_avg`
          )} ${candidateLogToken}_p50=${recordField(record, `${candidateLogToken}_p50`)}`
        );
        if (hasRecordField(record, "delta_vs_historical_immediate_parent_overall_score_p50")) {
          lines.push(
            `delta_vs_historical_immediate_parent_overall_score_p50=${recordField(
              record,
              "delta_vs_historical_immediate_parent_overall_score_p50"
            )}`
          );
        }
        if (hasRecordField(record, "delta_vs_immediate_parent_overall_score_p50")) {
          lines.push(
            `delta_vs_immediate_parent_overall_score_p50=${recordField(
              record,
              "delta_vs_immediate_parent_overall_score_p50"
            )} (legacy historical)`
          );
        }
        if (hasRecordField(record, "display_preset_improvement_vs_native_avg")) {
          lines.push(
            `display_preset_improvement_vs_native_avg=${recordField(
              record,
              "display_preset_improvement_vs_native_avg"
            )}`
          );
        }
        if (hasRecordField(record, "preset_score_p50")) {
          lines.push(`preset_score_p50=${recordField(record, "preset_score_p50")}`);
        }
        if (hasRecordField(record, "display_preset_improvement_vs_native_p50")) {
          lines.push(
            `display_preset_improvement_vs_native_p50=${recordField(
              record,
              "display_preset_improvement_vs_native_p50"
            )}`
          );
        }
      } else {
        lines.push("benchmark skipped");
      }

      if (hasRecordField(record, "anchor_id") || hasRecordField(record, "anchor_score_p50")) {
        lines.push(
          `anchor_id=${recordField(record, "anchor_id")} anchor_score_p50=${recordField(
            record,
            "anchor_score_p50"
          )} delta_vs_anchor_score_p50=${recordField(record, "delta_vs_anchor_score_p50")}`
        );
      }

      if (hasRecordField(record, "suite_presets")) {
        lines.push(
          `suite_presets=${recordField(record, "suite_presets")} primary_metric=${recordField(
            record,
            "primary_metric"
          )}`
        );
        lines.push(
          `benchmark_flow=${recordField(record, "benchmark_flow")} order_mode=${recordField(
            record,
            "order_mode"
          )} ab_testing=${recordField(record, "ab_testing")} warmup_enabled=${recordField(
            record,
            "warmup_enabled"
          )} warmup_runs_per_combination=${recordField(record, "warmup_runs_per_combination")}`
        );

        const presetIds = recordField(record, "suite_presets", "")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        for (let i = 0; i < presetIds.length; i += 1) {
          const presetId = presetIds[i];
          const currentKey = `preset_${presetId}_score_p50`;
          const anchorKey = `anchor_preset_${presetId}_score_p50`;
          const deltaKey = `delta_vs_anchor_preset_${presetId}_score_p50`;
          if (hasRecordField(record, currentKey) || hasRecordField(record, anchorKey)) {
            lines.push(
              `${currentKey}=${recordField(record, currentKey)} ${anchorKey}=${recordField(
                record,
                anchorKey
              )} ${deltaKey}=${recordField(record, deltaKey)}`
            );
          }
        }
      }

      if (hasRecordField(record, "passed") || hasRecordField(record, "failed")) {
        lines.push(
          `tests passed=${recordField(record, "passed")} failed=${recordField(
            record,
            "failed"
          )} total_ms=${recordField(record, "total_ms")}`
        );
      } else {
        lines.push("tests skipped");
      }

      if (hasRecordField(record, "threshold") || hasRecordField(record, "tests_failed")) {
        lines.push(
          `decision auto threshold=${recordField(record, "threshold")} tests_failed=${recordField(
            record,
            "tests_failed"
          )}`
        );
      }
      if (
        hasRecordField(record, "anchor_preset_score_p50") ||
        hasRecordField(record, "current_preset_score_p50")
      ) {
        lines.push(
          `anchor_preset_score_p50=${recordField(
            record,
            "anchor_preset_score_p50"
          )} current_preset_score_p50=${recordField(
            record,
            "current_preset_score_p50"
          )} delta_vs_anchor_preset_score_p50=${recordField(
            record,
            "delta_vs_anchor_preset_score_p50"
          )}`
        );
      }
      if (hasRecordField(record, "benchmark_step_total") || hasRecordField(record, "iteration_total")) {
        lines.push(
          `benchmark_step_total=${recordField(record, "benchmark_step_total")} iteration_total=${recordField(
            record,
            "iteration_total"
          )}`
        );
      }
      if (
        hasRecordField(record, "suite_benchmark_current_total") ||
        hasRecordField(record, "suite_benchmark_parent_total")
      ) {
        lines.push(
          `suite_benchmark_current_total=${recordField(
            record,
            "suite_benchmark_current_total"
          )} suite_benchmark_anchor_total=${recordField(
            record,
            "suite_benchmark_anchor_total"
          )} suite_benchmark_parent_total=${recordField(
            record,
            "suite_benchmark_parent_total"
          )} suite_benchmark_immediate_parent_total=${recordField(
            record,
            "suite_benchmark_immediate_parent_total"
          )}`
        );
      }
      if (hasRecordField(record, "suite_benchmark_combined_total")) {
        lines.push(
          `suite_benchmark_combined_total=${recordField(record, "suite_benchmark_combined_total")}`
        );
      }
      if (
        hasRecordField(record, "overall_score_p50") ||
        hasRecordField(record, "anchor_overall_score_p50")
      ) {
        lines.push(
          `overall_score_p50=${recordField(record, "overall_score_p50")} anchor_overall_score_p50=${recordField(
            record,
            "anchor_overall_score_p50"
          )} delta_vs_anchor_overall_score_p50=${recordField(
            record,
            "delta_vs_anchor_overall_score_p50"
          )} delta_vs_immediate_parent_same_session_overall_score_p50=${recordField(
            record,
            "delta_vs_immediate_parent_same_session_overall_score_p50"
          )} anchor_improvement_vs_native_overall_p50=${recordField(
            record,
            "anchor_improvement_vs_native_overall_p50"
          )} improvement_vs_native_overall_p50=${recordField(
            record,
            "improvement_vs_native_overall_p50"
          )}`
        );
      }

      return `${lines.join("\n")}\n\n`;
    }

    if (type === "non_strategic_failure") {
      lines.push(`[${recordField(record, "created_at")}] non-strategic auto-record failure`);
      lines.push(
        `reason=${recordField(record, "reason", "unknown")} parent=${recordField(
          record,
          "parent"
        )} anchor=${recordField(record, "anchor")}`
      );
      if (hasRecordField(record, "idea")) {
        lines.push(`idea=${recordField(record, "idea", "")}`);
      }
      if (hasRecordField(record, "syntax_message")) {
        lines.push(`syntax_message=${recordField(record, "syntax_message", "")}`);
      }
      if (hasRecordField(record, "passed") || hasRecordField(record, "failed")) {
        lines.push(
          `tests passed=${recordField(record, "passed")} failed=${recordField(
            record,
            "failed"
          )} total_ms=${recordField(record, "total_ms")}`
        );
      }
      lines.push("");
      return `${lines.join("\n")}\n`;
    }

    return "";
  }

  return {
    candidateLogToken,
    formatPct,
    formatMs,
    formatDuration,
    formatScore,
    scoreToImprovementVsNativePct,
    toNumberOrNull,
    baselineMetrics,
    candidateMetrics,
    csvEscape,
    formatCsvValue,
    parseCsvHeaderLine,
    buildSnapshotProgressRecord,
    buildNonStrategicFailureProgressRecord,
    buildProgressLogEntryFromRecord,
  };
}

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}

function freezeEntries(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export const CANONICAL_PRESET_CATALOG = freezeEntries([
  {
    key: "quick",
    name: "Quick",
    rowCount: 10000,
    seed: 20260321,
    runs: 3,
    generationId: "quick-10k",
    generationLabel: "Quick 10,000",
  },
  {
    key: "medium",
    name: "Medium",
    rowCount: 50000,
    seed: 20260322,
    runs: 3,
    generationId: "medium-50k",
    generationLabel: "Medium 50,000",
  },
  {
    key: "balanced",
    name: "Balanced",
    rowCount: 100000,
    seed: 20260323,
    runs: 3,
    generationId: "balanced-100k",
    generationLabel: "Balanced 100,000",
  },
  {
    key: "large",
    name: "Large",
    rowCount: 250000,
    seed: 20260324,
    runs: 3,
    generationId: "large-250k",
    generationLabel: "Large 250,000",
  },
  {
    key: "huge",
    name: "Huge",
    rowCount: 1000000,
    seed: 20260325,
    runs: 3,
    generationId: "huge-1m",
    generationLabel: "Huge 1,000,000",
  },
]);

export const BENCHMARK_PRESETS = freezeEntries(
  CANONICAL_PRESET_CATALOG.map((preset) => {
    return {
      id: preset.key,
      label: `${preset.name} ${formatCount(preset.rowCount)} rows`,
      rowCount: preset.rowCount,
      runs: preset.runs,
      seed: preset.seed,
    };
  })
);

export const DEFAULT_BENCHMARK_PRESET_IDS = Object.freeze(["quick", "medium"]);

export const GENERATION_PRESETS = freezeEntries(
  CANONICAL_PRESET_CATALOG.map((preset) => {
    return {
      id: preset.generationId,
      label: preset.generationLabel,
      rowCount: preset.rowCount,
      seed: preset.seed,
    };
  })
);

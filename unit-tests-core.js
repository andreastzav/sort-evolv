import {
  SORT_CASES,
  buildSortDescriptors,
  createRowComparator,
  runSortBenchmark,
} from "./benchmarks_core.js";
import { generateRows } from "./generation_core.js";
import { nativeSortInPlace } from "./native-sort.js";
import { decodeTableBinary, encodeRowsToBinary } from "./store_table_core.js";
import { resolveFallbackSortingProfile } from "./sorting_profile_core.js";

let CANDIDATE_SORT_FN = null;
let CANDIDATE_LABEL = "candidate";
let CANDIDATE_SORTER_ID = "candidate";
let loadedCandidateProfileSignature = "";
let ACTIVE_TEST_PROFILE = resolveFallbackSortingProfile();

function candidateModuleSpecifier(profile) {
  const raw = String(profile.workingFile || "").trim().replace(/\\/g, "/");
  if (raw === "") {
    throw new Error(
      'Active sorting profile must resolve a non-empty "workingFile". Pass --sorting <id>.'
    );
  }
  if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("/")) {
    return raw;
  }
  return `./${raw}`;
}

function profileSignature(profile) {
  return `${profile.sortingId}|${profile.workingFile}|${profile.candidateSorterId}|${profile.candidateLabel}`;
}

async function ensureCandidateLoaded(profile) {
  const signature = profileSignature(profile);
  if (loadedCandidateProfileSignature === signature && typeof CANDIDATE_SORT_FN === "function") {
    return;
  }

  const CANDIDATE_MODULE = await import(candidateModuleSpecifier(profile));
  const candidateSortFn =
    CANDIDATE_MODULE && typeof CANDIDATE_MODULE.default === "function"
      ? CANDIDATE_MODULE.default
      : null;
  if (!candidateSortFn) {
    throw new Error(
      `Candidate sorter module "${candidateModuleSpecifier(profile)}" must export a default function.`
    );
  }

  CANDIDATE_SORT_FN = candidateSortFn;
  CANDIDATE_LABEL = String(profile.candidateLabel || "candidate");
  CANDIDATE_SORTER_ID = String(profile.candidateSorterId || "candidate");
  ACTIVE_TEST_PROFILE = profile;
  loadedCandidateProfileSignature = signature;
}

function nowMs() {
  if (
    typeof performance !== "undefined" &&
    performance &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }

  return Date.now();
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createSeededNumberGenerator(seed) {
  let state = seed >>> 0;
  return function next() {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function buildRandomNumberArray(length, seed) {
  const random = createSeededNumberGenerator(seed);
  const values = new Array(length);
  for (let i = 0; i < length; i += 1) {
    values[i] = Math.floor(random() * 200000) - 100000;
  }

  return values;
}

function assertNumberArrayEqual(actual, expected, message) {
  assertCondition(
    Array.isArray(actual) && Array.isArray(expected),
    `${message}: both values must be arrays.`
  );
  assertCondition(
    actual.length === expected.length,
    `${message}: length mismatch (${actual.length} !== ${expected.length}).`
  );

  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${message}: mismatch at index ${i} (${actual[i]} !== ${expected[i]}).`
      );
    }
  }
}

function assertReferenceOrderEqual(actual, expected, message) {
  assertCondition(
    Array.isArray(actual) && Array.isArray(expected),
    `${message}: both values must be arrays.`
  );
  assertCondition(
    actual.length === expected.length,
    `${message}: length mismatch (${actual.length} !== ${expected.length}).`
  );

  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${message}: mismatch at index ${i}.`);
    }
  }
}

function assertRowsSorted(rows, comparator, message) {
  for (let i = 1; i < rows.length; i += 1) {
    if (comparator(rows[i - 1], rows[i]) > 0) {
      throw new Error(`${message}: order violation at index ${i}.`);
    }
  }
}

const TEST_CASES = Object.freeze([
  {
    id: "random-number-equivalence",
    name: `${CANDIDATE_LABEL} matches native sort for random number arrays`,
    run() {
      for (let caseIndex = 0; caseIndex < 25; caseIndex += 1) {
        const source = buildRandomNumberArray(3000, 9000 + caseIndex);
        const nativeSorted = source.slice();
        const candidateSorted = source.slice();

        nativeSortInPlace(nativeSorted, (a, b) => a - b);
        CANDIDATE_SORT_FN(candidateSorted, (a, b) => a - b);
        assertNumberArrayEqual(
          candidateSorted,
          nativeSorted,
          `${CANDIDATE_LABEL} numeric equality check failed`
        );
      }
    },
  },
  {
    id: "stable-equal-keys",
    name: `${CANDIDATE_LABEL} keeps stable order for equal keys`,
    run() {
      const rows = [];
      for (let i = 0; i < 4000; i += 1) {
        rows.push({
          bucket: i % 9,
          stableIndex: i,
        });
      }

      const sorted = rows.slice();
      CANDIDATE_SORT_FN(sorted, (left, right) => left.bucket - right.bucket);

      for (let i = 1; i < sorted.length; i += 1) {
        const previous = sorted[i - 1];
        const current = sorted[i];
        assertCondition(
          previous.bucket <= current.bucket,
          `bucket ordering failed at index ${i}.`
        );

        if (previous.bucket === current.bucket) {
          assertCondition(
            previous.stableIndex < current.stableIndex,
            `stability failed at index ${i} for bucket ${current.bucket}.`
          );
        }
      }
    },
  },
  {
    id: "benchmark-engine-shape",
    name: "benchmark engine runs both sorters and returns metrics",
    run() {
      const rows = generateRows(2000, { seed: 20260321 });
      const candidateSorter = {
        id: CANDIDATE_SORTER_ID,
        label: CANDIDATE_LABEL,
        sortInPlace(array, compareFn) {
          return CANDIDATE_SORT_FN(array, compareFn);
        }
      };
      const report = runSortBenchmark(rows, {
        runs: 1,
        sorters: [candidateSorter, "native"],
        candidateSorter,
        profile: ACTIVE_TEST_PROFILE,
        validateSorted: true,
      });

      assertCondition(report.rowCount === 2000, "unexpected rowCount.");
      assertCondition(
        report.sorterSummaries.length === 2,
        "unexpected sorter summary length."
      );
      assertCondition(
        report.sorterSummaries[0].cases.length === SORT_CASES.length,
        "unexpected case summary length."
      );
      assertCondition(
        report.totalBenchmarkMs >= 0,
        "totalBenchmarkMs must be non-negative."
      );

      for (let sorterIndex = 0; sorterIndex < report.sorterSummaries.length; sorterIndex += 1) {
        const sorterSummary = report.sorterSummaries[sorterIndex];
        for (let caseIndex = 0; caseIndex < sorterSummary.cases.length; caseIndex += 1) {
          const caseSummary = sorterSummary.cases[caseIndex];
          assertCondition(
            caseSummary.sampleCount === 2,
            "each case should have 2 samples (asc + desc with runs=1)."
          );
        }
      }
    },
  },
  {
    id: "comparator-determinism",
    name: "row comparator sorts generated rows deterministically",
    run() {
      const rows = generateRows(1500, { seed: 777 });
      const comparator = createRowComparator([
        { key: "city", direction: "asc" },
        { key: "age", direction: "desc" },
      ]);

      const nativeSorted = rows.slice();
      const candidateSorted = rows.slice();
      nativeSortInPlace(nativeSorted, comparator);
      CANDIDATE_SORT_FN(candidateSorted, comparator);

      assertReferenceOrderEqual(
        candidateSorted,
        nativeSorted,
        "comparator determinism check failed"
      );
    },
  },
  {
    id: "sort-case-direction-matrix-parity",
    name: `${CANDIDATE_LABEL} matches native across all sort cases and directions`,
    run() {
      const rows = generateRows(1500, { seed: 1337 });
      const directions = ["asc", "desc"];

      for (let caseIndex = 0; caseIndex < SORT_CASES.length; caseIndex += 1) {
        const benchCase = SORT_CASES[caseIndex];

        for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
          const direction = directions[directionIndex];
          const descriptors = buildSortDescriptors(benchCase.keys, direction);
          const comparator = createRowComparator(descriptors);
          const nativeSorted = rows.slice();
          const candidateSorted = rows.slice();

          nativeSortInPlace(nativeSorted, comparator);
          CANDIDATE_SORT_FN(candidateSorted, comparator);
          assertReferenceOrderEqual(
            candidateSorted,
            nativeSorted,
            `matrix parity failed for ${benchCase.id} (${direction})`
          );
          assertRowsSorted(
            candidateSorted,
            comparator,
            `sorted output check failed for ${benchCase.id} (${direction})`
          );
        }
      }
    },
  },
  {
    id: "small-input-edge-cases",
    name: `${CANDIDATE_LABEL} handles small and ordered edge cases`,
    run() {
      const cases = [
        [],
        [1],
        [2, 1],
        [1, 1, 1, 1],
        [1, 2, 3, 4, 5],
        [5, 4, 3, 2, 1],
        [3, -1, 7, 0, 7, -5, 2],
      ];

      for (let i = 0; i < cases.length; i += 1) {
        const source = cases[i];
        const nativeSorted = source.slice();
        const candidateSorted = source.slice();
        nativeSortInPlace(nativeSorted, (a, b) => a - b);
        CANDIDATE_SORT_FN(candidateSorted, (a, b) => a - b);
        assertNumberArrayEqual(
          candidateSorted,
          nativeSorted,
          `small edge case mismatch at case index ${i}`
        );
      }
    },
  },
  {
    id: "binary-roundtrip",
    name: "binary table store roundtrip keeps sampled row values",
    run() {
      const rows = generateRows(5000, { seed: 424242 });
      const encoded = encodeRowsToBinary(rows);
      const decoded = decodeTableBinary(encoded).rows;

      assertCondition(decoded.length === rows.length, "decoded row count mismatch.");

      const indexes = [0, 1, 2, 42, 777, 2048, rows.length - 3, rows.length - 2, rows.length - 1];
      for (let i = 0; i < indexes.length; i += 1) {
        const index = indexes[i];
        const source = rows[index];
        const restored = decoded[index];

        assertCondition(Number(source.index) === Number(restored.index), `index mismatch at ${index}.`);
        assertCondition(String(source.firstName) === String(restored.firstName), `firstName mismatch at ${index}.`);
        assertCondition(String(source.lastName) === String(restored.lastName), `lastName mismatch at ${index}.`);
        assertCondition(Number(source.age) === Number(restored.age), `age mismatch at ${index}.`);
        assertCondition(String(source.city) === String(restored.city), `city mismatch at ${index}.`);
        assertCondition(
          String(source.date) === String(restored.date),
          `date mismatch at ${index}.`
        );
        assertCondition(
          String(source.segment) === String(restored.segment),
          `segment mismatch at ${index}.`
        );
        assertCondition(Number(source.cohort) === Number(restored.cohort), `cohort mismatch at ${index}.`);
        assertCondition(
          Number(source.randomA) === Number(restored.randomA),
          `randomA mismatch at ${index}.`
        );
        assertCondition(
          Number(source.randomB) === Number(restored.randomB),
          `randomB mismatch at ${index}.`
        );
      }
    },
  },
]);

export async function runUnitTestSuite(options = {}) {
  const profile =
    options.profile && typeof options.profile === "object"
      ? options.profile
      : resolveFallbackSortingProfile();
  await ensureCandidateLoaded(profile);

  const stopOnFail = options.stopOnFail === true;
  const onResult =
    typeof options.onResult === "function" ? options.onResult : null;
  const results = [];
  const startedAtMs = nowMs();
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TEST_CASES.length; i += 1) {
    const testCase = TEST_CASES[i];
    const testStartMs = nowMs();

    try {
      testCase.run();
      const durationMs = nowMs() - testStartMs;
      const result = {
        id: testCase.id,
        name: testCase.name,
        status: "pass",
        durationMs,
      };
      results.push(result);
      passed += 1;
      if (onResult) {
        onResult(result);
      }
    } catch (error) {
      const durationMs = nowMs() - testStartMs;
      const errorMessage =
        error && error.message ? error.message : String(error);
      const result = {
        id: testCase.id,
        name: testCase.name,
        status: "fail",
        durationMs,
        errorMessage,
      };
      results.push(result);
      failed += 1;
      if (onResult) {
        onResult(result);
      }

      if (stopOnFail) {
        break;
      }
    }
  }

  return {
    passed,
    failed,
    total: results.length,
    totalMs: nowMs() - startedAtMs,
    results,
  };
}


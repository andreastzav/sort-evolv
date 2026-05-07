const MIN_RUN_SMALL = 16;
const MIN_RUN_MEDIUM = 24;
const MIN_RUN_LARGE = 32;
const MIN_RUN_HUGE = 48;
const LOW_CARDINALITY_SAMPLE_COUNT = 24;
const LOW_CARDINALITY_CLASS_RATIO = 0.45;
const LOW_CARDINALITY_MIN_LENGTH = 2048;

function defaultComparator(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function chooseMinRun(length) {
  if (length < 256) {
    return MIN_RUN_SMALL;
  }
  if (length < 4096) {
    return MIN_RUN_MEDIUM;
  }
  if (length < 65536) {
    return MIN_RUN_LARGE;
  }
  return MIN_RUN_HUGE;
}

function reverseRange(array, start, end) {
  let left = start;
  let right = end - 1;
  while (left < right) {
    const value = array[left];
    array[left] = array[right];
    array[right] = value;
    left += 1;
    right -= 1;
  }
}

function binaryInsertionSort(array, start, end, from, compare) {
  let cursor = from;
  if (cursor <= start) {
    cursor = start + 1;
  }

  for (; cursor < end; cursor += 1) {
    const pivot = array[cursor];
    let left = start;
    let right = cursor;

    while (left < right) {
      const middle = (left + right) >>> 1;
      if (compare(pivot, array[middle]) < 0) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }

    for (let move = cursor; move > left; move -= 1) {
      array[move] = array[move - 1];
    }
    array[left] = pivot;
  }
}

function scanNaturalRun(array, start, end, compare) {
  let cursor = start + 1;
  if (cursor >= end) {
    return cursor;
  }

  if (compare(array[cursor], array[cursor - 1]) < 0) {
    cursor += 1;
    while (cursor < end && compare(array[cursor], array[cursor - 1]) < 0) {
      cursor += 1;
    }
    reverseRange(array, start, cursor);
    return cursor;
  }

  cursor += 1;
  while (cursor < end && compare(array[cursor], array[cursor - 1]) >= 0) {
    cursor += 1;
  }
  return cursor;
}

function mergeStable(array, scratch, start, middle, end, compare) {
  if (start >= middle || middle >= end) {
    return;
  }

  if (compare(array[middle - 1], array[middle]) <= 0) {
    return;
  }

  let left = start;
  let right = middle;
  let write = start;

  while (left < middle && right < end) {
    if (compare(array[left], array[right]) <= 0) {
      scratch[write] = array[left];
      left += 1;
    } else {
      scratch[write] = array[right];
      right += 1;
    }
    write += 1;
  }

  while (left < middle) {
    scratch[write] = array[left];
    left += 1;
    write += 1;
  }

  while (right < end) {
    scratch[write] = array[right];
    right += 1;
    write += 1;
  }

  for (let i = start; i < end; i += 1) {
    array[i] = scratch[i];
  }
}

function collectAdaptiveRuns(array, compare) {
  const runs = [];
  const length = array.length;
  const minRun = chooseMinRun(length);
  let cursor = 0;

  while (cursor < length) {
    const runStart = cursor;
    let runEnd = scanNaturalRun(array, runStart, length, compare);

    if (runEnd - runStart < minRun) {
      const forcedEnd = Math.min(length, runStart + minRun);
      binaryInsertionSort(array, runStart, forcedEnd, runEnd, compare);
      runEnd = forcedEnd;
    }

    runs.push({
      start: runStart,
      end: runEnd,
    });
    cursor = runEnd;
  }

  return runs;
}

function mergeRunPass(array, scratch, runs, compare) {
  const merged = [];

  for (let i = 0; i < runs.length; i += 2) {
    const left = runs[i];
    const right = runs[i + 1];

    if (!right) {
      merged.push(left);
      continue;
    }

    mergeStable(array, scratch, left.start, left.end, right.end, compare);
    merged.push({
      start: left.start,
      end: right.end,
    });
  }

  return merged;
}

function shouldFallbackToNativeSort(array, compare) {
  const length = array.length;
  if (length < LOW_CARDINALITY_MIN_LENGTH) {
    return false;
  }

  const sampleCount = Math.min(LOW_CARDINALITY_SAMPLE_COUNT, length);
  if (sampleCount < 8) {
    return false;
  }

  const step = Math.max(1, Math.floor(length / sampleCount));
  const classes = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const index = Math.min(length - 1, i * step);
    const value = array[index];
    let matched = false;

    for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
      if (compare(value, classes[classIndex]) === 0) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      classes.push(value);
      if (classes.length > sampleCount * LOW_CARDINALITY_CLASS_RATIO) {
        return false;
      }
    }
  }

  return classes.length <= sampleCount * LOW_CARDINALITY_CLASS_RATIO;
}

function codexSortInPlace(array, compare) {
  if (!Array.isArray(array)) {
    throw new TypeError("Can only sort arrays");
  }

  if (array.length < 2) {
    return array;
  }

  if (shouldFallbackToNativeSort(array, compare)) {
    array.sort(compare);
    return array;
  }

  let runs = collectAdaptiveRuns(array, compare);
  if (runs.length < 2) {
    return array;
  }

  const scratch = new Array(array.length);
  while (runs.length > 1) {
    runs = mergeRunPass(array, scratch, runs, compare);
  }

  return array;
}

function FastCodexSort(array, compareFn) {
  const compare = typeof compareFn === "function" ? compareFn : defaultComparator;
  return codexSortInPlace(array, compare);
}

const runtimeGlobal =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : null;

if (runtimeGlobal) {
  runtimeGlobal.FastCodexSort = FastCodexSort;
}

export default FastCodexSort;

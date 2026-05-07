const MIN_RUN_SMALL = 16;
const MIN_RUN_MEDIUM = 24;
const MIN_RUN_LARGE = 32;
const MIN_RUN_HUGE = 64;

const SMALL_RANGE_LIMIT = 48;
const MERGE_BLOCK_SIZE = 32;
const MIN_GALLOP = 7;
const MIN_GALLOP_ARRAY_LENGTH = 65536;
const QUICK_MAX_DEPTH_MULTIPLIER = 2;

const LOW_CARDINALITY_SAMPLE_COUNT = 32;
const LOW_CARDINALITY_CLASS_RATIO = 0.55;
const LOW_CARDINALITY_MIN_LENGTH = 2048;
const LOW_CARDINALITY_BUCKET_MAX_CLASSES = 64;

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

function bubblePreconditionRange(array, start, end, compare) {
  const length = end - start;
  if (length < 3) {
    return;
  }

  let swapped = false;
  for (let i = start + 1; i < end; i += 1) {
    if (compare(array[i], array[i - 1]) < 0) {
      const value = array[i];
      array[i] = array[i - 1];
      array[i - 1] = value;
      swapped = true;
    }
  }

  if (!swapped) {
    return;
  }

  for (let i = end - 2; i >= start; i -= 1) {
    if (compare(array[i + 1], array[i]) < 0) {
      const value = array[i];
      array[i] = array[i + 1];
      array[i + 1] = value;
    }
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

function gallopLeftRunEnd(array, start, end, pivot, compare) {
  if (start >= end || compare(array[start], pivot) > 0) {
    return start;
  }

  let offset = 1;
  while (start + offset < end && compare(array[start + offset], pivot) <= 0) {
    offset = (offset << 1) + 1;
  }

  let low = start + (offset >>> 1) + 1;
  let high = Math.min(end, start + offset + 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(array[middle], pivot) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function gallopRightRunEnd(array, start, end, pivot, compare) {
  if (start >= end || compare(array[start], pivot) >= 0) {
    return start;
  }

  let offset = 1;
  while (start + offset < end && compare(array[start + offset], pivot) < 0) {
    offset = (offset << 1) + 1;
  }

  let low = start + (offset >>> 1) + 1;
  let high = Math.min(end, start + offset + 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(array[middle], pivot) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
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
  let leftWins = 0;
  let rightWins = 0;
  const allowGallop = array.length >= MIN_GALLOP_ARRAY_LENGTH;

  while (left < middle && right < end) {
    if (compare(array[left], array[right]) <= 0) {
      scratch[write] = array[left];
      left += 1;
      leftWins += 1;
      rightWins = 0;
      if (allowGallop && leftWins >= MIN_GALLOP && left < middle) {
        const gallopEnd = gallopLeftRunEnd(array, left, middle, array[right], compare);
        while (left < gallopEnd) {
          scratch[++write] = array[left];
          left += 1;
        }
        leftWins = 0;
      }
    } else {
      scratch[write] = array[right];
      right += 1;
      rightWins += 1;
      leftWins = 0;
      if (allowGallop && rightWins >= MIN_GALLOP && right < end) {
        const gallopEnd = gallopRightRunEnd(array, right, end, array[left], compare);
        while (right < gallopEnd) {
          scratch[++write] = array[right];
          right += 1;
        }
        rightWins = 0;
      }
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

function mergeSortRange(array, scratch, start, end, compare) {
  const length = end - start;
  if (length < 2) {
    return;
  }

  for (let blockStart = start; blockStart < end; blockStart += MERGE_BLOCK_SIZE) {
    const blockEnd = Math.min(end, blockStart + MERGE_BLOCK_SIZE);
    binaryInsertionSort(array, blockStart, blockEnd, blockStart + 1, compare);
  }

  let width = MERGE_BLOCK_SIZE;
  while (width < length) {
    const span = width * 2;
    for (let left = start; left < end; left += span) {
      const middle = Math.min(end, left + width);
      const right = Math.min(end, middle + width);
      mergeStable(array, scratch, left, middle, right, compare);
    }
    width *= 2;
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

function runLength(run) {
  return run.end - run.start;
}

function mergeRunAt(array, scratch, runs, index, compare) {
  const left = runs[index];
  const right = runs[index + 1];
  mergeStable(array, scratch, left.start, left.end, right.end, compare);
  runs[index] = {
    start: left.start,
    end: right.end,
  };
  runs.splice(index + 1, 1);
}

function collapseRunStack(array, scratch, runs, compare) {
  while (runs.length > 1) {
    const n = runs.length - 2;

    if (
      n > 0 &&
      runLength(runs[n - 1]) <= runLength(runs[n]) + runLength(runs[n + 1])
    ) {
      if (runLength(runs[n - 1]) < runLength(runs[n + 1])) {
        mergeRunAt(array, scratch, runs, n - 1, compare);
      } else {
        mergeRunAt(array, scratch, runs, n, compare);
      }
      continue;
    }

    if (runLength(runs[n]) <= runLength(runs[n + 1])) {
      mergeRunAt(array, scratch, runs, n, compare);
      continue;
    }

    break;
  }
}

function forceCollapseRunStack(array, scratch, runs, compare) {
  while (runs.length > 1) {
    const n = runs.length - 2;
    if (n > 0 && runLength(runs[n - 1]) < runLength(runs[n + 1])) {
      mergeRunAt(array, scratch, runs, n - 1, compare);
    } else {
      mergeRunAt(array, scratch, runs, n, compare);
    }
  }
}

function choosePivotMedianOfNine(array, start, end, compare) {
  const length = end - start;
  if (length < 9) {
    return array[start + (length >>> 1)];
  }

  const sample = new Array(9);
  const step = (length - 1) / 8;
  for (let i = 0; i < 9; i += 1) {
    sample[i] = array[start + Math.floor(i * step)];
  }

  for (let i = 1; i < sample.length; i += 1) {
    const value = sample[i];
    let j = i;
    while (j > 0 && compare(value, sample[j - 1]) < 0) {
      sample[j] = sample[j - 1];
      j -= 1;
    }
    sample[j] = value;
  }

  return sample[4];
}

function stableThreeWayPartition(array, scratch, start, end, pivot, compare) {
  let lessCount = 0;
  let equalCount = 0;
  let greaterCount = 0;

  for (let i = start; i < end; i += 1) {
    const cmp = compare(array[i], pivot);
    if (cmp < 0) {
      lessCount += 1;
    } else if (cmp > 0) {
      greaterCount += 1;
    } else {
      equalCount += 1;
    }
  }

  let lessWrite = start;
  let equalWrite = start + lessCount;
  let greaterWrite = equalWrite + equalCount;

  for (let i = start; i < end; i += 1) {
    const value = array[i];
    const cmp = compare(value, pivot);
    if (cmp < 0) {
      scratch[lessWrite] = value;
      lessWrite += 1;
    } else if (cmp > 0) {
      scratch[greaterWrite] = value;
      greaterWrite += 1;
    } else {
      scratch[equalWrite] = value;
      equalWrite += 1;
    }
  }

  for (let i = start; i < end; i += 1) {
    array[i] = scratch[i];
  }

  return {
    lessEnd: start + lessCount,
    greaterStart: start + lessCount + equalCount,
  };
}

function hasLowCardinalitySignal(array, compare) {
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

function tryStableBucketSort(array, compare) {
  const reps = [];
  const buckets = [];

  for (let i = 0; i < array.length; i += 1) {
    const value = array[i];
    let matchedIndex = -1;

    for (let classIndex = 0; classIndex < reps.length; classIndex += 1) {
      if (compare(value, reps[classIndex]) === 0) {
        matchedIndex = classIndex;
        break;
      }
    }

    if (matchedIndex >= 0) {
      buckets[matchedIndex].push(value);
      continue;
    }

    if (reps.length >= LOW_CARDINALITY_BUCKET_MAX_CLASSES) {
      return false;
    }

    let insertAt = reps.length;
    for (let classIndex = 0; classIndex < reps.length; classIndex += 1) {
      if (compare(value, reps[classIndex]) < 0) {
        insertAt = classIndex;
        break;
      }
    }

    reps.splice(insertAt, 0, value);
    buckets.splice(insertAt, 0, [value]);
  }

  let write = 0;
  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
    const bucket = buckets[bucketIndex];
    for (let itemIndex = 0; itemIndex < bucket.length; itemIndex += 1) {
      array[write] = bucket[itemIndex];
      write += 1;
    }
  }

  return true;
}

function stablePartitionQuickSort(array, compare) {
  const length = array.length;
  if (length < 2) {
    return array;
  }

  const scratch = new Array(length);
  const maxDepth =
    Math.max(4, ((Math.log(length) / Math.log(2)) | 0) * QUICK_MAX_DEPTH_MULTIPLIER);
  const stack = [[0, length, 0]];

  while (stack.length > 0) {
    const frame = stack.pop();
    const start = frame[0];
    const end = frame[1];
    const depth = frame[2];
    const frameLength = end - start;

    if (frameLength < 2) {
      continue;
    }

    if (frameLength <= SMALL_RANGE_LIMIT) {
      bubblePreconditionRange(array, start, end, compare);
      binaryInsertionSort(array, start, end, start + 1, compare);
      continue;
    }

    if (depth >= maxDepth) {
      mergeSortRange(array, scratch, start, end, compare);
      continue;
    }

    const pivot = choosePivotMedianOfNine(array, start, end, compare);
    const partition = stableThreeWayPartition(
      array,
      scratch,
      start,
      end,
      pivot,
      compare
    );
    const leftLength = partition.lessEnd - start;
    const rightLength = end - partition.greaterStart;

    if (leftLength === 0 && rightLength === 0) {
      continue;
    }

    if (leftLength === 0 || rightLength === 0) {
      mergeSortRange(array, scratch, start, end, compare);
      continue;
    }

    if (leftLength >= rightLength) {
      stack.push([start, partition.lessEnd, depth + 1]);
      stack.push([partition.greaterStart, end, depth + 1]);
    } else {
      stack.push([partition.greaterStart, end, depth + 1]);
      stack.push([start, partition.lessEnd, depth + 1]);
    }
  }

  return array;
}

function codexRunMergeSort(array, compare) {
  const runs = collectAdaptiveRuns(array, compare);
  if (runs.length < 2) {
    return array;
  }

  const scratch = new Array(array.length);
  const stack = [];
  for (let i = 0; i < runs.length; i += 1) {
    stack.push(runs[i]);
    collapseRunStack(array, scratch, stack, compare);
  }
  forceCollapseRunStack(array, scratch, stack, compare);

  return array;
}

function codexSortInPlace(array, compare) {
  if (!Array.isArray(array)) {
    throw new TypeError("Can only sort arrays");
  }

  const length = array.length;
  if (length < 2) {
    return array;
  }

  if (
    length >= LOW_CARDINALITY_MIN_LENGTH &&
    hasLowCardinalitySignal(array, compare) &&
    tryStableBucketSort(array, compare)
  ) {
    return array;
  }

  return codexRunMergeSort(array, compare);
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

const SMALL_PARTITION_THRESHOLD = 96;
const MAX_DEPTH_MULTIPLIER = 2;
const HIGH_ORDERED_RATIO = 0.75;

const runtimeGlobal =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : null;

let cachedQuadSortRangeFn =
  runtimeGlobal && typeof runtimeGlobal.FastQuadSortRange === "function"
    ? runtimeGlobal.FastQuadSortRange
    : null;

function defaultComparator(a, b) {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
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

function resolveQuadSortRange() {
  if (typeof cachedQuadSortRangeFn === "function") {
    return cachedQuadSortRangeFn;
  }

  if (
    runtimeGlobal &&
    typeof runtimeGlobal.FastQuadSortRange === "function"
  ) {
    cachedQuadSortRangeFn = runtimeGlobal.FastQuadSortRange;
    return cachedQuadSortRangeFn;
  }

  if (runtimeGlobal && typeof runtimeGlobal.FastQuadSort === "function") {
    cachedQuadSortRangeFn = function quadSortRangeThroughWholeSort(
      array,
      start,
      end,
      compare
    ) {
      if (start === 0 && end === array.length) {
        runtimeGlobal.FastQuadSort(array, compare);
        return;
      }

      const slice = array.slice(start, end);
      runtimeGlobal.FastQuadSort(slice, compare);
      for (let i = 0; i < slice.length; i += 1) {
        array[start + i] = slice[i];
      }
    };
    return cachedQuadSortRangeFn;
  }

  cachedQuadSortRangeFn = function fallbackRangeSort(array, start, end, compare) {
    const slice = array.slice(start, end);
    slice.sort(compare);
    for (let i = 0; i < slice.length; i += 1) {
      array[start + i] = slice[i];
    }
  };
  return cachedQuadSortRangeFn;
}

function sortSmallSample(sample, compare) {
  for (let i = 1; i < sample.length; i += 1) {
    const value = sample[i];
    let left = 0;
    let right = i;

    while (left < right) {
      const middle = (left + right) >>> 1;
      if (compare(value, sample[middle]) < 0) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }

    for (let move = i; move > left; move -= 1) {
      sample[move] = sample[move - 1];
    }
    sample[left] = value;
  }
}

function choosePivot(array, start, end, compare) {
  const length = end - start;

  if (length <= 9) {
    return array[start + (length >>> 1)];
  }

  if (length < 2048) {
    const step = (length - 1) / 8;
    const sample = new Array(9);
    for (let i = 0; i < 9; i += 1) {
      sample[i] = array[start + Math.floor(i * step)];
    }
    sortSmallSample(sample, compare);
    return sample[4];
  }

  let sampleCount = 32;
  while (sampleCount < 1024 && sampleCount * sampleCount * sampleCount < length) {
    sampleCount *= 2;
  }

  const sample = new Array(sampleCount);
  const step = length / (sampleCount + 1);
  for (let i = 0; i < sampleCount; i += 1) {
    sample[i] = array[start + Math.floor((i + 1) * step)];
  }

  resolveQuadSortRange()(sample, 0, sample.length, compare);
  return sample[sampleCount >>> 1];
}

function analyzePresortedness(array, start, end, compare) {
  const length = end - start;
  if (length <= 1) {
    return {
      sorted: true,
      reverseSorted: false,
      orderedRatio: 1,
    };
  }

  let ascendingPairs = 0;
  let descendingPairs = 0;

  for (let i = start + 1; i < end; i += 1) {
    const cmp = compare(array[i - 1], array[i]);
    if (cmp <= 0) {
      ascendingPairs += 1;
    }
    if (cmp >= 0) {
      descendingPairs += 1;
    }
  }

  const pairs = length - 1;
  return {
    sorted: ascendingPairs === pairs,
    reverseSorted: descendingPairs === pairs,
    orderedRatio: Math.max(ascendingPairs, descendingPairs) / pairs,
  };
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

  if (greaterCount === 0 && lessCount === 0) {
    return {
      lessEnd: start,
      greaterStart: end,
    };
  }

  const length = end - start;
  let lessWrite = 0;
  let equalWrite = lessCount;
  let greaterWrite = lessCount + equalCount;

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

  for (let i = 0; i < length; i += 1) {
    array[start + i] = scratch[i];
  }

  return {
    lessEnd: start + lessCount,
    greaterStart: start + lessCount + equalCount,
  };
}

function fluxSortRange(array, start, end, compare) {
  if (!Array.isArray(array)) {
    throw new TypeError("Can only sort arrays");
  }

  const left = Math.max(0, start | 0);
  const right = Math.min(array.length, end | 0);
  const length = right - left;
  if (length < 2) {
    return array;
  }

  const presorted = analyzePresortedness(array, left, right, compare);
  if (presorted.sorted) {
    return array;
  }
  if (presorted.reverseSorted) {
    reverseRange(array, left, right);
    return array;
  }
  if (presorted.orderedRatio >= HIGH_ORDERED_RATIO) {
    resolveQuadSortRange()(array, left, right, compare);
    return array;
  }

  const scratch = new Array(length);
  const maxDepth =
    Math.max(1, ((Math.log(length) / Math.log(2)) | 0)) * MAX_DEPTH_MULTIPLIER;
  const stack = [[left, right, 0]];

  while (stack.length > 0) {
    const frame = stack.pop();
    const frameStart = frame[0];
    const frameEnd = frame[1];
    const depth = frame[2];
    const frameLength = frameEnd - frameStart;

    if (frameLength < 2) {
      continue;
    }

    if (frameLength <= SMALL_PARTITION_THRESHOLD || depth >= maxDepth) {
      resolveQuadSortRange()(array, frameStart, frameEnd, compare);
      continue;
    }

    const pivot = choosePivot(array, frameStart, frameEnd, compare);
    const partition = stableThreeWayPartition(
      array,
      scratch,
      frameStart,
      frameEnd,
      pivot,
      compare
    );
    const leftLength = partition.lessEnd - frameStart;
    const rightLength = frameEnd - partition.greaterStart;

    if (
      leftLength < (frameLength >>> 4) ||
      rightLength < (frameLength >>> 4)
    ) {
      resolveQuadSortRange()(array, frameStart, frameEnd, compare);
      continue;
    }

    if (leftLength >= rightLength) {
      if (leftLength > 1) {
        stack.push([frameStart, partition.lessEnd, depth + 1]);
      }
      if (rightLength > 1) {
        stack.push([partition.greaterStart, frameEnd, depth + 1]);
      }
    } else {
      if (rightLength > 1) {
        stack.push([partition.greaterStart, frameEnd, depth + 1]);
      }
      if (leftLength > 1) {
        stack.push([frameStart, partition.lessEnd, depth + 1]);
      }
    }
  }

  return array;
}

function FastFluxSort(array, compareFn) {
  const compare =
    typeof compareFn === "function" ? compareFn : defaultComparator;
  return fluxSortRange(array, 0, Array.isArray(array) ? array.length : 0, compare);
}

if (runtimeGlobal) {
  runtimeGlobal.FastFluxSort = FastFluxSort;
  runtimeGlobal.FastFluxSortRange = fluxSortRange;
}

export default FastFluxSort;

const DEFAULT_MIN_RUN = 32;

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

function binaryInsertionSort(array, start, end, from, compare) {
  let index = from;
  if (index <= start) {
    index = start + 1;
  }

  for (; index < end; index += 1) {
    const value = array[index];
    let left = start;
    let right = index;

    while (left < right) {
      const middle = (left + right) >>> 1;
      if (compare(value, array[middle]) < 0) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }

    for (let move = index; move > left; move -= 1) {
      array[move] = array[move - 1];
    }
    array[left] = value;
  }
}

function collectRuns(array, start, end, compare, minRun, runs) {
  let cursor = start;

  while (cursor < end) {
    const runStart = cursor;
    cursor += 1;

    if (cursor < end) {
      if (compare(array[cursor], array[cursor - 1]) < 0) {
        while (cursor < end && compare(array[cursor], array[cursor - 1]) < 0) {
          cursor += 1;
        }
        reverseRange(array, runStart, cursor);
      } else {
        while (cursor < end && compare(array[cursor], array[cursor - 1]) >= 0) {
          cursor += 1;
        }
      }
    }

    let runEnd = cursor;
    if (runEnd - runStart < minRun) {
      runEnd = Math.min(end, runStart + minRun);
      binaryInsertionSort(array, runStart, runEnd, cursor, compare);
      cursor = runEnd;
    }

    runs.push(runStart, runEnd);
  }
}

function mergeAdjacentRuns(array, scratch, leftStart, leftEnd, rightEnd, compare) {
  if (leftStart >= leftEnd || leftEnd >= rightEnd) {
    return;
  }

  if (compare(array[leftEnd - 1], array[leftEnd]) <= 0) {
    return;
  }

  let left = leftStart;
  let right = leftEnd;
  let write = 0;

  while (left < leftEnd && right < rightEnd) {
    if (compare(array[left], array[right]) <= 0) {
      scratch[write] = array[left];
      left += 1;
    } else {
      scratch[write] = array[right];
      right += 1;
    }
    write += 1;
  }

  while (left < leftEnd) {
    scratch[write] = array[left];
    write += 1;
    left += 1;
  }

  while (right < rightEnd) {
    scratch[write] = array[right];
    write += 1;
    right += 1;
  }

  for (let i = 0; i < write; i += 1) {
    array[leftStart + i] = scratch[i];
  }
}

function quadSortRange(array, start, end, compare) {
  if (!Array.isArray(array)) {
    throw new TypeError("Can only sort arrays");
  }

  const left = Math.max(0, start | 0);
  const right = Math.min(array.length, end | 0);
  const length = right - left;
  if (length < 2) {
    return array;
  }

  const minRun = length < DEFAULT_MIN_RUN ? 2 : DEFAULT_MIN_RUN;
  const runs = [];
  collectRuns(array, left, right, compare, minRun, runs);

  if (runs.length <= 2) {
    return array;
  }

  const scratch = new Array(length);
  let activeRuns = runs;

  while (activeRuns.length > 2) {
    const mergedRuns = [];
    for (let i = 0; i < activeRuns.length; i += 4) {
      const leftStart = activeRuns[i];
      const leftEnd = activeRuns[i + 1];
      const rightStart = activeRuns[i + 2];
      const rightEnd = activeRuns[i + 3];

      if (
        typeof rightStart !== "number" ||
        typeof rightEnd !== "number"
      ) {
        mergedRuns.push(leftStart, leftEnd);
        continue;
      }

      mergeAdjacentRuns(array, scratch, leftStart, leftEnd, rightEnd, compare);
      mergedRuns.push(leftStart, rightEnd);
    }

    activeRuns = mergedRuns;
  }

  return array;
}

function FastQuadSort(array, compareFn) {
  const compare =
    typeof compareFn === "function" ? compareFn : defaultComparator;
  return quadSortRange(array, 0, Array.isArray(array) ? array.length : 0, compare);
}

const runtimeGlobal =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : null;

if (runtimeGlobal) {
  runtimeGlobal.FastQuadSort = FastQuadSort;
  runtimeGlobal.FastQuadSortRange = quadSortRange;
}

export default FastQuadSort;

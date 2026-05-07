function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = values
    .map((value) => toFiniteNumber(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }

  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      sampleCount: 0,
      totalMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p75Ms: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
    };
  }

  let totalMs = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  let sampleCount = 0;
  const finiteValues = [];

  for (let i = 0; i < samples.length; i += 1) {
    const numeric = toFiniteNumber(samples[i]);
    if (!Number.isFinite(numeric)) {
      continue;
    }
    finiteValues.push(numeric);
    totalMs += numeric;
    sampleCount += 1;
    if (numeric < minMs) {
      minMs = numeric;
    }
    if (numeric > maxMs) {
      maxMs = numeric;
    }
  }

  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      totalMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p75Ms: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
    };
  }

  return {
    sampleCount,
    totalMs,
    avgMs: totalMs / sampleCount,
    p50Ms: percentile(finiteValues, 0.5),
    p75Ms: percentile(finiteValues, 0.75),
    p95Ms: percentile(finiteValues, 0.95),
    minMs,
    maxMs,
  };
}

export function geometricMeanPositive(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }

  let logSum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const numeric = toFiniteNumber(values[i]);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      continue;
    }
    logSum += Math.log(numeric);
    count += 1;
  }

  if (count === 0) {
    return Number.NaN;
  }

  return Math.exp(logSum / count);
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }

  const sorted = values
    .map((value) => toFiniteNumber(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return Number.NaN;
  }

  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mad(values, center) {
  const numericCenter = toFiniteNumber(center);
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(numericCenter)) {
    return Number.NaN;
  }

  const deviations = [];
  for (let i = 0; i < values.length; i += 1) {
    const numeric = toFiniteNumber(values[i]);
    if (!Number.isFinite(numeric)) {
      continue;
    }
    deviations.push(Math.abs(numeric - numericCenter));
  }

  return median(deviations);
}

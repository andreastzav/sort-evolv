import path from "node:path";
import {
  resolveBaselineTotals,
  resolveCandidateTotals
} from "./sorting_profile_core.js";

const SVG_THEME = Object.freeze({
  background: "#f8fafc",
  edge: "#94a3b8",
  edgeWinner: "#22c55e",
  edgeLoser: "#ef4444",
  nodeStroke: "#334155",
  nodeText: "#0f172a",
  nodeRoot: "#e2e8f0",
  nodeWinner: "#dcfce7",
  nodeLoser: "#fee2e2",
  nodeUnknown: "#e5e7eb"
});

const LAYOUT = Object.freeze({
  marginX: 20,
  marginTop: 102,
  marginBottom: 20,
  nodeWidth: 300,
  nodeHeight: 96,
  nodeGapX: 54,
  nodeGapY: 13
});

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.NaN;
}

function isFiniteNumber(value) {
  return Number.isFinite(toFiniteNumber(value));
}

function formatMs(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  return `${numeric.toFixed(2)} ms`;
}

function formatPct(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) {
    return "n/a";
  }

  const sign = numeric >= 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
}

function formatScore(value) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "n/a";
  }

  return numeric.toFixed(4);
}

function firstFinite(...values) {
  for (let i = 0; i < values.length; i += 1) {
    const numeric = toFiniteNumber(values[i]);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return Number.NaN;
}

function deriveScoreP50(entry, benchmarkTotals) {
  const explicitScore = toFiniteNumber(entry?.scoreP50);
  if (Number.isFinite(explicitScore) && explicitScore > 0) {
    return explicitScore;
  }

  const suiteScore = toFiniteNumber(entry?.benchmarkSuite?.current?.overallScore);
  if (Number.isFinite(suiteScore) && suiteScore > 0) {
    return suiteScore;
  }

  const decisionScore = toFiniteNumber(entry?.decision?.currentOverallScore);
  if (Number.isFinite(decisionScore) && decisionScore > 0) {
    return decisionScore;
  }

  const comparisonScore = toFiniteNumber(benchmarkTotals?.comparison?.geomeanScoreP50);
  if (Number.isFinite(comparisonScore) && comparisonScore > 0) {
    return comparisonScore;
  }

  const baselineP50 = toFiniteNumber(resolveBaselineTotals(benchmarkTotals)?.p50Ms);
  const candidateP50 = toFiniteNumber(resolveCandidateTotals(benchmarkTotals)?.p50Ms);
  if (
    Number.isFinite(baselineP50) &&
    baselineP50 > 0 &&
    Number.isFinite(candidateP50) &&
    candidateP50 > 0
  ) {
    return candidateP50 / baselineP50;
  }

  return Number.NaN;
}

function nodeIdNumber(nodeId) {
  const parsed = Number.parseInt(nodeId, 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.MAX_SAFE_INTEGER;
}

function normalizeNode(entry, fallbackParentId = null, orderIndex = 0) {
  const benchmarkTotals = entry && entry.benchmarkTotals ? entry.benchmarkTotals : null;
  const candidateAvgMs = toFiniteNumber(resolveCandidateTotals(benchmarkTotals)?.avgMs);
  const baselineAvgMs = toFiniteNumber(resolveBaselineTotals(benchmarkTotals)?.avgMs);
  const scoreP50 = deriveScoreP50(entry, benchmarkTotals);
  const anchorId =
    typeof entry?.anchorId === "string" && entry.anchorId.trim() !== ""
      ? entry.anchorId
      : typeof entry?.decision?.anchorId === "string" && entry.decision.anchorId.trim() !== ""
        ? entry.decision.anchorId
        : null;
  const anchorScore = firstFinite(
    entry?.anchorScore,
    entry?.decision?.parentOverallScore,
    entry?.benchmarkSuite?.parent?.overallScore
  );
  const deltaVsAnchorPct = firstFinite(
    entry?.deltaVsAnchorPct,
    entry?.decision?.overallDeltaVsAnchorPct
  );
  const status =
    entry && (entry.status === "winner" || entry.status === "loser" || entry.status === "root")
      ? entry.status
      : "unknown";

  return {
    id: String(entry && entry.id ? entry.id : "unknown"),
    parentId: entry && entry.parentId !== undefined ? entry.parentId : fallbackParentId,
    status,
    branchPath: entry && typeof entry.branchPath === "string" ? entry.branchPath : "ROOT",
    progressId: entry && entry.progressId ? String(entry.progressId) : null,
    idea: entry && typeof entry.idea === "string" ? entry.idea : "",
    deltaVsParentPct: entry ? toFiniteNumber(entry.deltaVsParentPct) : Number.NaN,
    deltaVsAnchorPct,
    scoreP50,
    anchorId,
    anchorScore,
    variantRootId: typeof entry?.variantRootId === "string" ? entry.variantRootId : null,
    variantStep: toFiniteNumber(entry?.variantStep),
    speculativeLossCount: toFiniteNumber(entry?.speculativeLossCount),
    candidateAvgMs,
    baselineAvgMs,
    nativeAvgMs: baselineAvgMs,
    createdAt: entry && typeof entry.createdAt === "string" ? entry.createdAt : "",
    file: entry && typeof entry.file === "string" ? entry.file : "",
    orderIndex
  };
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Invalid metadata: expected object.");
  }

  if (!metadata.root || typeof metadata.root !== "object") {
    throw new Error("Invalid metadata: missing root.");
  }

  const root = normalizeNode(
    {
      ...metadata.root,
      status: metadata.root.status === "loser" ? "loser" : "root",
      branchPath: metadata.root.branchPath || "ROOT"
    },
    null,
    0
  );
  const snapshots = Array.isArray(metadata.snapshots) ? metadata.snapshots : [];
  const nodes = [root];

  for (let i = 0; i < snapshots.length; i += 1) {
    nodes.push(normalizeNode(snapshots[i], root.id, i + 1));
  }

  return {
    rootId: root.id,
    nodes
  };
}

function statusToFillColor(status) {
  if (status === "root") {
    return SVG_THEME.nodeRoot;
  }
  if (status === "winner") {
    return SVG_THEME.nodeWinner;
  }
  if (status === "loser") {
    return SVG_THEME.nodeLoser;
  }
  return SVG_THEME.nodeUnknown;
}

function statusToEdgeColor(status) {
  if (status === "winner") {
    return SVG_THEME.edgeWinner;
  }
  if (status === "loser") {
    return SVG_THEME.edgeLoser;
  }
  return SVG_THEME.edge;
}

function computeDepthByNodeId(nodesById, rootId) {
  const memo = new Map();
  const visiting = new Set();

  function depthFor(nodeId) {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }

    if (nodeId === rootId) {
      memo.set(nodeId, 0);
      return 0;
    }

    if (visiting.has(nodeId)) {
      memo.set(nodeId, 0);
      return 0;
    }

    visiting.add(nodeId);
    const node = nodesById.get(nodeId);
    let depth = 0;

    if (node && node.parentId && nodesById.has(node.parentId)) {
      depth = depthFor(node.parentId) + 1;
    }

    visiting.delete(nodeId);
    memo.set(nodeId, depth);
    return depth;
  }

  for (const nodeId of nodesById.keys()) {
    depthFor(nodeId);
  }

  return memo;
}

function branchRootKey(branchPath) {
  if (typeof branchPath !== "string" || branchPath.trim() === "") {
    return "ZZZ";
  }
  const first = branchPath.split(".")[0];
  if (first === "ROOT") {
    return "AAA";
  }
  return first;
}

function orderNodes(nodes, rootId, depthById) {
  const root = nodes.find((node) => node.id === rootId);
  const rest = nodes.filter((node) => node.id !== rootId);

  rest.sort((left, right) => {
    const leftRootKey = branchRootKey(left.branchPath);
    const rightRootKey = branchRootKey(right.branchPath);
    if (leftRootKey < rightRootKey) {
      return -1;
    }
    if (leftRootKey > rightRootKey) {
      return 1;
    }

    if (left.branchPath < right.branchPath) {
      return -1;
    }
    if (left.branchPath > right.branchPath) {
      return 1;
    }

    const leftDepth = depthById.get(left.id) || 0;
    const rightDepth = depthById.get(right.id) || 0;
    if (leftDepth < rightDepth) {
      return -1;
    }
    if (leftDepth > rightDepth) {
      return 1;
    }

    return nodeIdNumber(left.id) - nodeIdNumber(right.id);
  });

  if (root) {
    return [root, ...rest];
  }

  return rest;
}

function buildNodeTooltip(node, parentNode) {
  const lines = [];
  lines.push(`id: ${node.id}`);
  lines.push(`status: ${node.status}`);
  lines.push(`branch: ${node.branchPath}`);
  lines.push(`score p50: ${formatScore(node.scoreP50)}`);
  lines.push(`anchor: ${node.anchorId || "n/a"} (score ${formatScore(node.anchorScore)})`);
  lines.push(`delta score vs anchor: ${formatPct(node.deltaVsAnchorPct)}`);
  lines.push(`delta score vs parent: ${formatPct(node.deltaVsParentPct)}`);
  if (isFiniteNumber(node.variantStep)) {
    lines.push(`variant step: ${Math.trunc(node.variantStep)}`);
  }
  if (isFiniteNumber(node.speculativeLossCount)) {
    lines.push(`speculative losses: ${Math.trunc(node.speculativeLossCount)}`);
  }
  if (node.variantRootId) {
    lines.push(`variant root: ${node.variantRootId}`);
  }
  if (node.file) {
    lines.push(`file: ${node.file}`);
  }
  const candidateLabel = String(node.candidateLabel || "candidate");
  if (isFiniteNumber(node.candidateAvgMs)) {
    lines.push(`${candidateLabel} avg: ${formatMs(node.candidateAvgMs)}`);
  }
  if (isFiniteNumber(node.baselineAvgMs)) {
    lines.push(`native avg: ${formatMs(node.baselineAvgMs)}`);
  }
  if (isFiniteNumber(node.deltaParentRuntimePct)) {
    lines.push(`delta runtime vs parent: ${formatPct(node.deltaParentRuntimePct)}`);
  } else if (parentNode && isFiniteNumber(parentNode.candidateAvgMs) && isFiniteNumber(node.candidateAvgMs)) {
    const fallbackDelta =
      ((node.candidateAvgMs - parentNode.candidateAvgMs) / parentNode.candidateAvgMs) * 100;
    lines.push(`delta runtime vs parent: ${formatPct(fallbackDelta)} (computed)`);
  }
  if (isFiniteNumber(node.deltaBestRuntimePct)) {
    lines.push(`delta runtime vs previous best: ${formatPct(node.deltaBestRuntimePct)}`);
  }
  if (node.idea) {
    lines.push(`idea: ${node.idea}`);
  }
  if (node.createdAt) {
    lines.push(`created: ${node.createdAt}`);
  }

  return lines.join("\n");
}

function buildNodeLabelLines(node) {
  const lines = [];
  lines.push(`${node.id} ${String(node.status).toUpperCase()}`);
  lines.push(node.branchPath || "ROOT");
  lines.push(`score: ${formatScore(node.scoreP50)} anchor: ${node.anchorId || "-"}`);
  lines.push(`delta a: ${formatPct(node.deltaVsAnchorPct)} p: ${formatPct(node.deltaVsParentPct)}`);
  lines.push(
    `v-step: ${isFiniteNumber(node.variantStep) ? Math.trunc(node.variantStep) : "-"} losses: ${
      isFiniteNumber(node.speculativeLossCount) ? Math.trunc(node.speculativeLossCount) : "-"
    }`
  );
  return lines;
}

function annotateRuntimeDeltas(nodes, rootId) {
  const nodesById = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    nodesById.set(nodes[i].id, nodes[i]);
  }

  const chronological = nodes.slice().sort((left, right) => {
    if (left.orderIndex !== right.orderIndex) {
      return left.orderIndex - right.orderIndex;
    }
    return nodeIdNumber(left.id) - nodeIdNumber(right.id);
  });

  let bestPrevMs = Number.POSITIVE_INFINITY;
  for (let i = 0; i < chronological.length; i += 1) {
    const node = chronological[i];
    const currentMs = toFiniteNumber(node.candidateAvgMs);
    let deltaParentRuntimePct = Number.NaN;
    let deltaBestRuntimePct = Number.NaN;

    if (node.id !== rootId && node.parentId) {
      const parentNode = nodesById.get(node.parentId);
      const parentMs = parentNode ? toFiniteNumber(parentNode.candidateAvgMs) : Number.NaN;
      if (Number.isFinite(currentMs) && Number.isFinite(parentMs) && parentMs > 0) {
        // Runtime delta: lower is better (winner => negative percentage).
        deltaParentRuntimePct = ((currentMs - parentMs) / parentMs) * 100;
      }
    }

    if (node.id !== rootId && Number.isFinite(currentMs) && Number.isFinite(bestPrevMs) && bestPrevMs > 0) {
      // Runtime delta vs best seen before this snapshot.
      deltaBestRuntimePct = ((currentMs - bestPrevMs) / bestPrevMs) * 100;
    }

    node.deltaParentRuntimePct = deltaParentRuntimePct;
    node.deltaBestRuntimePct = deltaBestRuntimePct;

    if (Number.isFinite(currentMs) && currentMs < bestPrevMs) {
      bestPrevMs = currentMs;
    }
  }

  return nodes;
}

function buildSvg(nodes, rootId, titleText) {
  annotateRuntimeDeltas(nodes, rootId);
  const nodesById = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    nodesById.set(nodes[i].id, nodes[i]);
  }

  const depthById = computeDepthByNodeId(nodesById, rootId);
  const ordered = orderNodes(nodes, rootId, depthById);
  const positionedNodes = new Map();

  let maxDepth = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const node = ordered[i];
    const depth = depthById.get(node.id) || 0;
    if (depth > maxDepth) {
      maxDepth = depth;
    }

    const x = LAYOUT.marginX + depth * (LAYOUT.nodeWidth + LAYOUT.nodeGapX);
    const y = LAYOUT.marginTop + i * (LAYOUT.nodeHeight + LAYOUT.nodeGapY);
    positionedNodes.set(node.id, {
      ...node,
      x,
      y,
      depth
    });
  }

  const width =
    LAYOUT.marginX * 2 + (maxDepth + 1) * LAYOUT.nodeWidth + maxDepth * LAYOUT.nodeGapX;
  const height =
    LAYOUT.marginTop +
    LAYOUT.marginBottom +
    ordered.length * LAYOUT.nodeHeight +
    Math.max(0, ordered.length - 1) * LAYOUT.nodeGapY;

  const edges = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const child = positionedNodes.get(ordered[i].id);
    if (!child || !child.parentId) {
      continue;
    }

    const parent = positionedNodes.get(child.parentId);
    if (!parent) {
      continue;
    }

    const startX = parent.x + LAYOUT.nodeWidth;
    const startY = parent.y + LAYOUT.nodeHeight / 2;
    const endX = child.x;
    const endY = child.y + LAYOUT.nodeHeight / 2;
    const dx = Math.max(30, (endX - startX) / 2);
    const color = statusToEdgeColor(child.status);
    const pathData = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
    edges.push(`<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2.2" marker-end="url(#arrow)" />`);
  }

  const nodeElements = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const node = positionedNodes.get(ordered[i].id);
    const fill = statusToFillColor(node.status);
    const lines = buildNodeLabelLines(node);
    const parentNode = node.parentId ? positionedNodes.get(node.parentId) : null;
    const tooltip = escapeXml(buildNodeTooltip(node, parentNode));

    const textY = node.y + 22;
    const tspanParts = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = escapeXml(lines[lineIndex]);
      if (lineIndex === 0) {
        tspanParts.push(
          `<tspan x="${node.x + 10}" y="${textY}" font-size="12" font-weight="700">${line}</tspan>`
        );
      } else {
        tspanParts.push(
          `<tspan x="${node.x + 10}" dy="15" font-size="11" font-weight="500">${line}</tspan>`
        );
      }
    }

    nodeElements.push(
      `<g class="node"><title>${tooltip}</title><rect x="${node.x}" y="${node.y}" rx="7" ry="7" width="${LAYOUT.nodeWidth}" height="${LAYOUT.nodeHeight}" fill="${fill}" stroke="${SVG_THEME.nodeStroke}" stroke-width="1.1" /><text fill="${SVG_THEME.nodeText}" font-family="Segoe UI, Arial, sans-serif">${tspanParts.join("")}</text></g>`
    );
  }

  const legendY = 66;
  const title = escapeXml(titleText);
  const nodeCountText = `Nodes: ${ordered.length}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${SVG_THEME.edge}" />
    </marker>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${SVG_THEME.background}" />
  <text x="${LAYOUT.marginX}" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="700" fill="${SVG_THEME.nodeText}">${title}</text>
  <text x="${LAYOUT.marginX}" y="48" font-family="Segoe UI, Arial, sans-serif" font-size="12" font-weight="500" fill="#475569">${escapeXml(
    nodeCountText
  )} | tooltip: hover node for full details</text>
  <g transform="translate(${LAYOUT.marginX}, ${legendY})">
    <rect x="0" y="-12" width="11" height="11" fill="${SVG_THEME.nodeRoot}" stroke="${SVG_THEME.nodeStroke}" stroke-width="1" />
    <text x="17" y="-2" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="${SVG_THEME.nodeText}">root</text>
    <rect x="70" y="-12" width="11" height="11" fill="${SVG_THEME.nodeWinner}" stroke="${SVG_THEME.nodeStroke}" stroke-width="1" />
    <text x="87" y="-2" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="${SVG_THEME.nodeText}">winner</text>
    <rect x="153" y="-12" width="11" height="11" fill="${SVG_THEME.nodeLoser}" stroke="${SVG_THEME.nodeStroke}" stroke-width="1" />
    <text x="170" y="-2" font-family="Segoe UI, Arial, sans-serif" font-size="11" fill="${SVG_THEME.nodeText}">loser</text>
  </g>
  <g class="edges">${edges.join("")}</g>
  <g class="nodes">${nodeElements.join("")}</g>
</svg>`;
}

function relativeSvgPathForHtml(svgPath, htmlPath) {
  const fromDir = path.dirname(path.resolve(htmlPath));
  const absoluteSvg = path.resolve(svgPath);
  const rel = path.relative(fromDir, absoluteSvg).replaceAll("\\", "/");
  if (rel === "") {
    return path.basename(absoluteSvg);
  }
  return rel;
}

function buildHtml(svgPath, htmlPath, titleText) {
  const relativeSvgPath = relativeSvgPathForHtml(svgPath, htmlPath);
  const title = escapeXml(titleText);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
    }
    body {
      margin: 0;
      padding: 20px;
      background: #f1f5f9;
      font-family: "Segoe UI", Arial, sans-serif;
      color: #0f172a;
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      line-height: 1.25;
    }
    p {
      margin: 0 0 14px 0;
      color: #334155;
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 8px 0;
    }
    .toolbar button {
      border: 1px solid #cbd5e1;
      background: #ffffff;
      color: #0f172a;
      border-radius: 6px;
      padding: 5px 9px;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
    }
    .toolbar button:hover {
      background: #f8fafc;
    }
    .zoom-label {
      font-size: 12px;
      color: #334155;
      min-width: 52px;
      text-align: right;
    }
    .card {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #ffffff;
      padding: 10px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
      max-height: calc(100vh - 140px);
    }
    .x-scroll-top {
      height: 14px;
      overflow-x: auto;
      overflow-y: hidden;
      margin-bottom: 8px;
      border-bottom: 1px solid #e2e8f0;
    }
    .x-scroll-spacer {
      height: 1px;
    }
    .viewport {
      overflow: auto;
      max-height: calc(100vh - 190px);
    }
    img {
      display: block;
      width: 130%;
      min-width: 100%;
      max-width: none;
      height: auto;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>Generated evolution graph. Hover nodes for details. Use top scrollbar for horizontal pan.</p>
  <div class="toolbar">
    <button id="zoomOut" type="button">-</button>
    <button id="zoomIn" type="button">+</button>
    <button id="zoomFit" type="button">Fit</button>
    <button id="zoomReset" type="button">100%</button>
    <span class="zoom-label" id="zoomLabel">130%</span>
  </div>
  <div class="card">
    <div class="x-scroll-top" id="xScrollTop"><div class="x-scroll-spacer" id="xScrollSpacer"></div></div>
    <div class="viewport" id="graphViewport">
      <img id="graphImage" src="${escapeXml(relativeSvgPath)}" alt="${title}" />
    </div>
  </div>
  <script>
    (function () {
      const topScroll = document.getElementById("xScrollTop");
      const spacer = document.getElementById("xScrollSpacer");
      const viewport = document.getElementById("graphViewport");
      const image = document.getElementById("graphImage");
      const zoomOutBtn = document.getElementById("zoomOut");
      const zoomInBtn = document.getElementById("zoomIn");
      const zoomFitBtn = document.getElementById("zoomFit");
      const zoomResetBtn = document.getElementById("zoomReset");
      const zoomLabel = document.getElementById("zoomLabel");

      if (!topScroll || !spacer || !viewport || !image || !zoomOutBtn || !zoomInBtn || !zoomFitBtn || !zoomResetBtn || !zoomLabel) {
        return;
      }

      let syncingFromTop = false;
      let syncingFromViewport = false;
      let zoomPct = 130;

      function clamp(value, minValue, maxValue) {
        return Math.max(minValue, Math.min(maxValue, value));
      }

      function updateZoomLabel() {
        zoomLabel.textContent = Math.round(zoomPct) + "%";
      }

      function syncSpacerWidth() {
        spacer.style.width = image.scrollWidth + "px";
      }

      function applyZoom(nextZoomPct) {
        zoomPct = clamp(nextZoomPct, 30, 500);
        image.style.width = zoomPct + "%";
        updateZoomLabel();
        syncSpacerWidth();
        topScroll.scrollLeft = viewport.scrollLeft;
      }

      function fitToViewport() {
        const naturalWidth = image.naturalWidth;
        if (!naturalWidth || naturalWidth <= 0) {
          return;
        }

        const fitPct = (viewport.clientWidth / naturalWidth) * 100;
        applyZoom(fitPct);
      }

      topScroll.addEventListener("scroll", () => {
        if (syncingFromViewport) {
          return;
        }
        syncingFromTop = true;
        viewport.scrollLeft = topScroll.scrollLeft;
        syncingFromTop = false;
      }, { passive: true });

      viewport.addEventListener("scroll", () => {
        if (syncingFromTop) {
          return;
        }
        syncingFromViewport = true;
        topScroll.scrollLeft = viewport.scrollLeft;
        syncingFromViewport = false;
      }, { passive: true });

      zoomOutBtn.addEventListener("click", () => {
        applyZoom(zoomPct - 10);
      });

      zoomInBtn.addEventListener("click", () => {
        applyZoom(zoomPct + 10);
      });

      zoomFitBtn.addEventListener("click", () => {
        fitToViewport();
      });

      zoomResetBtn.addEventListener("click", () => {
        applyZoom(100);
      });

      window.addEventListener("keydown", (event) => {
        if (!event.ctrlKey) {
          return;
        }

        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          applyZoom(zoomPct + 10);
          return;
        }

        if (event.key === "-") {
          event.preventDefault();
          applyZoom(zoomPct - 10);
          return;
        }

        if (event.key === "0") {
          event.preventDefault();
          applyZoom(100);
        }
      });

      function onReady() {
        applyZoom(zoomPct);
        topScroll.scrollLeft = viewport.scrollLeft;
      }

      if (image.complete) {
        onReady();
      } else {
        image.addEventListener("load", onReady, { once: true });
      }

      window.addEventListener("resize", syncSpacerWidth);
    })();
  </script>
</body>
</html>`;
}

export function buildEvolutionGraphArtifacts(metadata, options = {}) {
  const normalized = normalizeMetadata(metadata);
  const candidateLabel =
    typeof options.candidateLabel === "string" && options.candidateLabel.trim() !== ""
      ? options.candidateLabel.trim()
      : "candidate";
  for (let i = 0; i < normalized.nodes.length; i += 1) {
    normalized.nodes[i].candidateLabel = candidateLabel;
  }
  const title = typeof options.title === "string" && options.title.trim() !== ""
    ? options.title.trim()
    : `${candidateLabel} Evolution Graph`;
  const svg = buildSvg(normalized.nodes, normalized.rootId, title);
  const svgPath = options.svgPath || "evolution.svg";
  const htmlPath = options.htmlPath || "evolution.html";
  const html = buildHtml(svgPath, htmlPath, title);

  return {
    title,
    nodeCount: normalized.nodes.length,
    svg,
    html
  };
}

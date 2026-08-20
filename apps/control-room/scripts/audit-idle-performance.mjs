import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const viewportRoot = path.join(appRoot, "src/modules/viewport-3d");
const chartRoots = [
  path.join(appRoot, "src/modules/analysis-plots"),
  path.join(appRoot, "src/modules/live-charts"),
  path.join(appRoot, "src/shared/analysis-charts"),
];
const quickChartResourceView = readFileSync(
  path.join(appRoot, "src/shared/analysis-charts/QuickChartResourceView.tsx"),
  "utf8",
);
const viewportModule = readFileSync(
  path.join(viewportRoot, "Viewport3DModule.tsx"),
  "utf8",
);
const viewportTypes = readFileSync(
  path.join(viewportRoot, "viewport3dTypes.ts"),
  "utf8",
);
const visualizationDebugController = readFileSync(
  path.join(appRoot, "src/kernel/visualization/VisualizationDebugController.ts"),
  "utf8",
);
const visualizationDebugPublisher = readFileSync(
  path.join(
    viewportRoot,
    "hooks/useViewport3DVisualizationDebugPublisher.ts",
  ),
  "utf8",
);
const viewportDiagnostics = readFileSync(
  path.join(viewportRoot, "viewport3dDiagnostics.ts"),
  "utf8",
);

const failures = [];

if (!viewportTypes.includes('VIEWPORT_3D_FRAMELOOP = "demand"')) {
  failures.push("viewport3dTypes must export VIEWPORT_3D_FRAMELOOP = \"demand\".");
}

if (!viewportModule.includes("frameloop={VIEWPORT_3D_FRAMELOOP}")) {
  failures.push("Viewport3DModule must wire Canvas frameloop to VIEWPORT_3D_FRAMELOOP.");
}

for (const filePath of listSourceFiles(viewportRoot)) {
  const content = readFileSync(filePath, "utf8");
  const relativePath = path.relative(viewportRoot, filePath);
  if (
    content.includes("requestAnimationFrame(") &&
    !allowsViewport3DDemandFrameOneShots(relativePath, content)
  ) {
    failures.push(`${relativePath} uses requestAnimationFrame().`);
  }
  if (content.includes("setInterval(")) {
    failures.push(`${relativePath} uses setInterval().`);
  }
  if (content.includes('frameloop="always"')) {
    failures.push(`${relativePath} configures an always-on R3F frameloop.`);
  }
}

auditVisualizationDebugIdleContracts();
auditSettledR3FFrameContract();
auditChartIdleContracts();

if (failures.length > 0) {
  console.error(`Idle performance audit failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("Idle performance audit passed.");

function auditVisualizationDebugIdleContracts() {
  const sources = [visualizationDebugController, visualizationDebugPublisher];
  for (const source of sources) {
    if (source.includes("setInterval(")) {
      failures.push("Visualization Debug lifecycle uses setInterval().");
    }
  }
  if (!visualizationDebugPublisher.includes("scanFieldVectorDebugStatistics")) {
    failures.push("Visualization Debug publisher must own the demand-gated statistics scan.");
  }
  if (!visualizationDebugPublisher.includes("getDemandSnapshot(targetId).expanded")) {
    failures.push("Visualization Debug publisher must gate scans and commits on exact demand.");
  }
  if (!visualizationDebugPublisher.includes("state.lastCommittedFrameId === frame.commitId")) {
    failures.push("Visualization Debug publisher must suppress identical settled frame commits.");
  }
  for (const forbidden of ["invalidate(", "recordDirtyFrame("]) {
    if (visualizationDebugPublisher.includes(forbidden)) {
      failures.push(`Visualization Debug publisher must not call ${forbidden}.`);
    }
  }
}

function auditSettledR3FFrameContract() {
  if (!viewportDiagnostics.includes("recordVisualizationDebugViewportFrame(reason)")) {
    failures.push(
      "Idle performance audit requires settled R3F frames to use the opt-in viewport counter.",
    );
  }
}

function auditChartIdleContracts() {
  for (const root of chartRoots) {
    for (const filePath of listSourceFiles(root)) {
      if (isNonProductionSource(filePath)) continue;
      const content = readFileSync(filePath, "utf8");
      const relativePath = path.relative(appRoot, filePath);
      if (content.includes("setInterval(")) {
        failures.push(`${relativePath} uses setInterval().`);
      }
      if (content.includes("refreshInterval")) {
        failures.push(`${relativePath} configures polling through refreshInterval.`);
      }
      if (
        content.includes("requestAnimationFrame(") &&
        !allowsChartDemandFrameOneShots(relativePath, content)
      ) {
        failures.push(`${relativePath} uses an undocumented chart animation frame.`);
      }
    }
  }

  if (!quickChartResourceView.includes("useTableRowsBinaryResource")) {
    failures.push("QuickChartResourceView.tsx must remain revision-resource driven.");
  }
  if (quickChartResourceView.includes("setInterval(")) {
    failures.push("QuickChartResourceView.tsx must not poll while idle.");
  }
}

function allowsChartDemandFrameOneShots(relativePath, content) {
  if (
    relativePath !==
    path.join("src", "shared", "analysis-charts", "EChartsCanvasSurface.tsx")
  ) {
    return false;
  }
  return (
    countOccurrences(content, "requestAnimationFrame(") === 1 &&
    countOccurrences(content, "cancelAnimationFrame(frame)") === 2 &&
    content.includes("observer = new ResizeObserver") &&
    content.includes("observer?.disconnect()") &&
    content.includes("ownerRef.current?.dispose()")
  );
}

function allowsViewport3DDemandFrameOneShots(relativePath, content) {
  if (
    relativePath ===
    path.join("build-engine", "gpu", "viewport3dGpuUploadManager.ts")
  ) {
    const requestCount = countOccurrences(content, "requestAnimationFrame(");
    const cancelCount = countOccurrences(content, "cancelAnimationFrame(");
    return (
      requestCount === 1 &&
      cancelCount === 1 &&
      content.includes("function defaultScheduleFrame") &&
      content.includes("function defaultCancelFrame") &&
      content.includes("scheduleFrame(runFrame)") &&
      content.includes("targetFrameBudgetMs") &&
      content.includes("maxFrameBudgetMs")
    );
  }

  if (relativePath === path.join("layers", "FdmCuboidLayer.tsx")) {
    const requestCount = countOccurrences(content, "requestAnimationFrame(");
    const cancelCount = countOccurrences(content, "cancelAnimationFrame(");
    return (
      requestCount === 1 &&
      cancelCount === 1 &&
      content.includes("const handleInspectPointerMove = (event: PointerEvent)") &&
      content.includes("processInspectPointerMove(eventToProcess)") &&
      content.includes("passive: true")
    );
  }

  if (relativePath !== path.join("layers", "Viewport3DScene.tsx")) {
    return false;
  }

  const requestCount = countOccurrences(content, "requestAnimationFrame(");
  const cancelCount = countOccurrences(content, "cancelAnimationFrame(");
  return (
    // Camera projection, staged model layers, render adoption, and resource
    // acknowledgement plus pointer inspection arbitration are bounded one-shot frames.
    requestCount === 5 &&
    cancelCount === 5 &&
    content.includes("idle-audit-allow-one-shot-raf") &&
    content.includes('tracker.recordDirtyFrame("camera-projection-followup")') &&
    content.includes('tracker.recordDirtyFrame("resources-updated")') &&
    content.includes('tracker.recordDirtyFrame("model-layer-stage")') &&
    content.includes("invalidate();") &&
    content.includes("createFdmInspectClearArbitrator") &&
    content.includes("inspectClearArbitrator.dispose()")
  );
}

function countOccurrences(content, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = content.indexOf(needle, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function isNonProductionSource(filePath) {
  return (
    filePath.includes(".test.") ||
    filePath.includes(".stories.") ||
    filePath.endsWith(".d.ts")
  );
}

function listSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(filePath));
      continue;
    }

    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(filePath);
    }
  }
  return files;
}

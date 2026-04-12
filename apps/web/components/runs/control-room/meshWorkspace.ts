"use client";

import type { EngineLogEntry } from "../../../lib/useSessionStream";
import type {
  MeshBuildIntent,
  MeshWorkspaceState,
  ModelBuilderGraphV2,
  SceneDocument,
} from "../../../lib/session/types";
import { resolveMeshBuildIntentFromNodeId } from "../../../lib/session/modelBuilderGraph";
import type { MeshQualityData, MeshOptionsState } from "../../panels/MeshSettingsPanel";
import type { RenderMode } from "../../preview/FemMeshView3D";
import type { FemDockTab, ViewportMode } from "./shared";
import { type LucideIcon, Grid3x3, Box, Scissors, Activity, Zap } from "lucide-react";
import { resolveObjectNameFromNodeId } from "../../panels/settings/objectSelection";

export type MeshWorkspacePresetId =
  | "inspect-surface"
  | "inspect-volume"
  | "slice"
  | "quality"
  | "optimize";

export interface MeshWorkspacePreset {
  id: MeshWorkspacePresetId;
  label: string;
  shortLabel: string;
  description: string;
  viewMode: ViewportMode;
  dockTab: FemDockTab;
  renderMode: RenderMode;
  icon: LucideIcon;
  clipEnabled?: boolean;
  opacity?: number;
}

export interface MeshPipelinePhaseStatus {
  id: "import" | "classify" | "generate" | "optimize" | "quality" | "readiness";
  label: string;
  status: "idle" | "active" | "done" | "warning";
  detail: string | null;
}

export interface MeshBuildDialogIntent {
  mode: "selected" | "all";
  targetNodeId: string | null;
  targetLabel: string;
  title: string;
  contextLabel: string | null;
  buildIntent: MeshBuildIntent;
}

export interface MeshBuildStage {
  id:
    | "queued"
    | "materializing"
    | "preparing_domain"
    | "meshing"
    | "postprocessing"
    | "ready"
    | "failed";
  label: string;
  status: "idle" | "active" | "done" | "warning";
  detail: string | null;
}

export interface EffectiveMeshTarget {
  geometryName: string;
  source: "study_default" | "local_override";
  hmax: number | null;
  hmin: number | null;
  algorithm2d: number | null;
  algorithm3d: number | null;
}

export interface MeshBuildRuntimeState {
  status: "idle" | "running" | "success" | "failure";
  generating: boolean;
  errorMessage: string | null;
  hasStructuredSuccess: boolean;
}

export const MESH_WORKSPACE_PRESETS: MeshWorkspacePreset[] = [
  {
    id: "inspect-surface",
    label: "Inspect Surface",
    shortLabel: "Surface",
    description: "Surface skin with boundary edges and face inspection.",
    viewMode: "Mesh",
    dockTab: "view",
    renderMode: "surface+edges",
    icon: Grid3x3,
    clipEnabled: false,
    opacity: 100,
  },
  {
    id: "inspect-volume",
    label: "Inspect Volume",
    shortLabel: "Volume",
    description: "Volume-oriented wireframe to verify tetrahedral fill.",
    viewMode: "Mesh",
    dockTab: "view",
    renderMode: "wireframe",
    icon: Box,
    clipEnabled: false,
    opacity: 100,
  },
  {
    id: "slice",
    label: "Slice Workspace",
    shortLabel: "Slice",
    description: "2D cross-section through the tetra mesh.",
    viewMode: "2D",
    dockTab: "view",
    renderMode: "wireframe",
    icon: Scissors,
    clipEnabled: false,
    opacity: 100,
  },
  {
    id: "quality",
    label: "Quality Review",
    shortLabel: "Quality",
    description: "Mesh diagnostics, worst elements and quality histograms.",
    viewMode: "Mesh",
    dockTab: "quality",
    renderMode: "surface+edges",
    icon: Activity,
    clipEnabled: false,
    opacity: 100,
  },
  {
    id: "optimize",
    label: "Optimize & Generate",
    shortLabel: "Optimize",
    description: "Mesher controls, precompute policy and pipeline feedback.",
    viewMode: "Mesh",
    dockTab: "mesher",
    renderMode: "wireframe",
    icon: Zap,
    clipEnabled: true,
    opacity: 82,
  },
];

export const MESH_RENDER_MODE_OPTIONS: Array<{ value: RenderMode; label: string }> = [
  { value: "surface", label: "Surface" },
  { value: "surface+edges", label: "Surface+Edges" },
  { value: "wireframe", label: "Wireframe" },
  { value: "points", label: "Points" },
];

export function deriveMeshWorkspacePreset(args: {
  viewMode: ViewportMode;
  femDockTab: FemDockTab;
  meshRenderMode: RenderMode;
}): MeshWorkspacePresetId {
  const { viewMode, femDockTab, meshRenderMode } = args;
  if (viewMode === "2D") return "slice";
  if (femDockTab === "quality") return "quality";
  if (femDockTab === "mesher" || femDockTab === "pipeline") return "optimize";
  if (meshRenderMode === "surface") return "inspect-surface";
  return "inspect-volume";
}

export function meshWorkspaceNodeToDockTab(nodeId: string): FemDockTab | null {
  switch (nodeId) {
    case "universe-airbox-mesh":
      return "mesh";
    case "universe-mesh-view":
    case "mesh-view":
      return "view";
    case "universe-mesh-size":
    case "universe-mesh-algorithm":
    case "mesh-size":
    case "mesh-algorithm":
      return "mesher";
    case "universe-mesh-quality":
    case "mesh-quality":
      return "quality";
    case "universe-mesh-pipeline":
    case "mesh-pipeline":
      return "pipeline";
    case "universe-mesh":
    case "mesh":
      return "mesh";
    default:
      return null;
  }
}

export function meshWorkspaceNodeToPreset(nodeId: string): MeshWorkspacePresetId | null {
  switch (nodeId) {
    case "universe-airbox-mesh":
      return "inspect-surface";
    case "universe-mesh-view":
    case "mesh-view":
      return "inspect-volume";
    case "universe-mesh-size":
    case "universe-mesh-algorithm":
    case "mesh-size":
    case "mesh-algorithm":
      return "optimize";
    case "universe-mesh-quality":
    case "mesh-quality":
      return "quality";
    case "universe-mesh":
    case "mesh":
      return "inspect-surface";
    default:
      return null;
  }
}

export function isMeshNodeId(nodeId: string | null | undefined): boolean {
  if (!nodeId) {
    return false;
  }
  return (
    nodeId === "universe-airbox" ||
    nodeId.startsWith("universe-airbox") ||
    nodeId === "universe-boundary" ||
    nodeId === "universe-mesh" ||
    nodeId.startsWith("universe-mesh-") ||
    nodeId === "mesh" ||
    nodeId.startsWith("mesh-") ||
    (nodeId.startsWith("geo-") && nodeId.endsWith("-mesh"))
  );
}

export function meshBuildIntentForNode(args: {
  mode: "selected" | "all";
  nodeId: string | null | undefined;
  sceneDocument: SceneDocument | null;
  modelBuilderGraph: ModelBuilderGraphV2 | null;
  hasSharedAirboxDomain: boolean;
}): MeshBuildDialogIntent {
  const { mode, nodeId, sceneDocument, modelBuilderGraph, hasSharedAirboxDomain } = args;
  if (mode === "all") {
    return {
      mode,
      targetNodeId: nodeId ?? null,
      targetLabel: "shared study-domain mesh",
      title: "Build All",
      contextLabel: null,
      buildIntent: { mode: "all", target: { kind: "study_domain" } },
    };
  }

  const buildIntent =
    resolveMeshBuildIntentFromNodeId(nodeId, modelBuilderGraph)
    ?? { mode: "selected", target: { kind: "study_domain" } as const };
  let contextLabel: string | null = null;
  if (buildIntent.target.kind === "object_mesh") {
    contextLabel =
      `object override · ${
        resolveObjectNameFromNodeId(nodeId ?? undefined, sceneDocument?.objects ?? [])
        ?? buildIntent.target.object_id
        ?? "selected object"
      }`;
  } else if (buildIntent.target.kind === "airbox") {
    contextLabel = "airbox sizing / shared-domain envelope";
  }
  return {
    mode,
    targetNodeId: nodeId ?? (hasSharedAirboxDomain ? "mesh" : "universe-mesh"),
    targetLabel: "shared study-domain mesh",
    title: "Build Selected",
    contextLabel,
    buildIntent,
  };
}

export function buildMeshConfigurationSignature(
  sceneDocument: SceneDocument | null,
): string | null {
  if (!sceneDocument) {
    return null;
  }
  return JSON.stringify({
    revision: sceneDocument.revision,
    source_of_truth: sceneDocument.scene.source_of_truth ?? "repo_head",
    authoring_schema: sceneDocument.scene.authoring_schema ?? "mesh-first-fem.v1",
    universe: sceneDocument.universe,
    universe_mesh: sceneDocument.study.universe_mesh ?? sceneDocument.universe,
    shared_domain_mesh: sceneDocument.study.shared_domain_mesh ?? sceneDocument.study.mesh_defaults,
    objects: sceneDocument.objects.map((object) => ({
      id: object.id,
      name: object.name,
      geometry: object.geometry,
      transform: object.transform,
      region_name: object.region_name,
      object_mesh: object.object_mesh ?? object.mesh_override,
    })),
  });
}

export function deriveMeshBuildRuntimeState(args: {
  meshWorkspace: MeshWorkspaceState | null;
  commandStatus: {
    command_kind?: string | null;
    state?: string | null;
    completion_state?: string | null;
    reason?: string | null;
  } | null;
  meshGenerating: boolean;
  scriptSyncBusy: boolean;
}): MeshBuildRuntimeState {
  const { meshWorkspace, commandStatus, meshGenerating, scriptSyncBusy } = args;
  const remeshCommand = commandStatus?.command_kind === "remesh" ? commandStatus : null;
  const commandRejected =
    remeshCommand?.state === "rejected"
      ? remeshCommand.reason ?? "Mesh build command was rejected"
      : null;
  const commandFailed =
    remeshCommand?.state === "completed" &&
    remeshCommand.completion_state != null &&
    remeshCommand.completion_state !== "ok"
      ? remeshCommand.completion_state
      : null;
  const workspaceFailed = meshWorkspace?.last_build_error ?? null;
  const failureMessage = commandRejected ?? commandFailed ?? workspaceFailed;
  if (failureMessage) {
    return {
      status: "failure",
      generating: false,
      errorMessage: failureMessage,
      hasStructuredSuccess: false,
    };
  }

  const activeBuild = meshWorkspace?.active_build ?? null;
  if (scriptSyncBusy || meshGenerating || activeBuild != null) {
    return {
      status: "running",
      generating: true,
      errorMessage: null,
      hasStructuredSuccess: false,
    };
  }

  const structuredSuccess =
    remeshCommand?.state === "completed" &&
    remeshCommand.completion_state === "ok" &&
    activeBuild == null &&
    meshWorkspace?.last_build_summary != null;
  if (structuredSuccess) {
    return {
      status: "success",
      generating: false,
      errorMessage: null,
      hasStructuredSuccess: true,
    };
  }

  return {
    status: "idle",
    generating: false,
    errorMessage: null,
    hasStructuredSuccess: false,
  };
}

function stageStatus(
  stageIndex: number,
  activeStage: number,
  failed: boolean,
  ready: boolean,
): MeshBuildStage["status"] {
  if (failed && stageIndex === activeStage) {
    return "warning";
  }
  if (ready && stageIndex <= activeStage) {
    return "done";
  }
  if (stageIndex < activeStage) {
    return "done";
  }
  if (stageIndex === activeStage) {
    return failed ? "warning" : "active";
  }
  return "idle";
}

export function buildMeshBuildStages(args: {
  meshWorkspace: MeshWorkspaceState | null;
  workspaceStatus: string;
  meshGenerating: boolean;
  scriptSyncBusy: boolean;
  latestActivityLabel: string | null;
  latestActivityDetail: string | null;
  commandMessage: string | null;
  engineLog: EngineLogEntry[];
}): MeshBuildStage[] {
  const {
    meshWorkspace,
    workspaceStatus,
    meshGenerating,
    scriptSyncBusy,
    latestActivityLabel,
    latestActivityDetail,
    commandMessage,
    engineLog,
  } = args;
  if (
    meshWorkspace?.mesh_pipeline_status?.length &&
    (
      meshWorkspace.active_build != null ||
      meshWorkspace.last_build_summary != null ||
      meshWorkspace.last_build_error != null ||
      meshWorkspace.mesh_pipeline_status.some((phase) => phase.id === "queued")
    )
  ) {
    return meshWorkspace.mesh_pipeline_status.map((phase) => ({
      id:
        phase.id === "queued" ||
        phase.id === "materializing" ||
        phase.id === "preparing_domain" ||
        phase.id === "meshing" ||
        phase.id === "postprocessing" ||
        phase.id === "ready"
          ? phase.id
          : "queued",
      label: phase.label,
      status:
        phase.status === "queued"
          ? "active"
          : phase.status === "failed"
            ? "warning"
            : phase.status,
      detail: phase.detail,
    }));
  }
  const latestMessage = engineLog.length > 0 ? engineLog[engineLog.length - 1]?.message ?? null : null;
  const lower = (latestMessage ?? commandMessage ?? latestActivityDetail ?? "").toLowerCase();
  const missingStructuredTelemetry =
    meshGenerating &&
    (!meshWorkspace?.mesh_pipeline_status || meshWorkspace.mesh_pipeline_status.length === 0);
  const failed =
    workspaceStatus === "failed" ||
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("rejected");
  const ready =
    !meshGenerating &&
    !scriptSyncBusy &&
    (lower.includes("mesh ready") ||
      lower.includes("remesh complete") ||
      lower.includes("script materialized") ||
      lower.includes("interactive workspace ready"));

  let activeStage = 0;
  if (scriptSyncBusy || lower.includes("script_sync") || lower.includes("loading python script")) {
    activeStage = 1;
  }
  if (
    lower.includes("building explicit fem mesh asset") ||
    lower.includes("preparing shared fem domain mesh asset") ||
    lower.includes("shared-domain local sizing active") ||
    lower.includes("adding airbox domain") ||
    lower.includes("building problemir")
  ) {
    activeStage = 2;
  }
  if (
    lower.includes("meshing stl surface") ||
    lower.includes("importing stl surface") ||
    lower.includes("classifying stl surfaces") ||
    lower.includes("creating geometry from classified surfaces") ||
    lower.includes("generating 3d tetrahedral mesh")
  ) {
    activeStage = 3;
  }
  if (
    lower.includes("extracting quality metrics") ||
    lower.includes("quality") ||
    lower.includes("post-process") ||
    lower.includes("pipeline")
  ) {
    activeStage = 4;
  }
  if (ready) {
    activeStage = 5;
  }
  if (!meshGenerating && !scriptSyncBusy && !ready && !failed) {
    activeStage = 0;
  }

  return [
    {
      id: failed ? "failed" : "queued",
      label: failed ? "Failed" : "Queued",
      status: failed ? "warning" : stageStatus(0, activeStage, failed, ready),
      detail:
        failed
          ? (latestMessage ?? commandMessage ?? latestActivityDetail ?? "Mesh build failed before completion.")
          : missingStructuredTelemetry
            ? "Build telemetry unavailable. The backend is still working, but structured mesh progress events did not reach this session snapshot."
            : (commandMessage ?? "Build request accepted and waiting for the next mesh pipeline step."),
    },
    {
      id: "materializing",
      label: "Materializing Script",
      status: stageStatus(1, activeStage, failed, ready),
      detail:
        scriptSyncBusy
          ? "Syncing the active scene back to canonical Python before remeshing."
          : "Preparing the script and runtime scene for the next shared-domain remesh.",
    },
    {
      id: "preparing_domain",
      label: "Preparing Shared Domain",
      status: stageStatus(2, activeStage, failed, ready),
      detail:
        lower.includes("shared-domain")
          ? (latestMessage ?? latestActivityDetail)
          : "Computing airbox/domain inputs, local sizing fields and the conformal FEM domain setup.",
    },
    {
      id: "meshing",
      label: "Meshing",
      status: stageStatus(3, activeStage, failed, ready),
      detail:
        lower.includes("gmsh")
          ? (latestMessage ?? latestActivityDetail)
          : "Generating the tetrahedral mesh for the active shared domain.",
    },
    {
      id: "postprocessing",
      label: "Post-Processing",
      status: stageStatus(4, activeStage, failed, ready),
      detail:
        latestActivityLabel === "Materializing"
          ? latestActivityDetail
          : "Collecting mesh quality, markers and runtime-ready mesh metadata.",
    },
    {
      id: "ready",
      label: failed ? "Ready" : "Ready",
      status: stageStatus(5, activeStage, failed, ready),
      detail:
        ready
          ? (latestMessage ?? "Mesh build completed and the viewport can now inspect the updated domain mesh.")
          : "Waiting for the next finished mesh generation.",
    },
  ];
}

export function deriveMeshBuildProgressValue(
  stages: MeshBuildStage[],
  fallbackValue: number | null | undefined,
): number {
  if (typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) {
    return Math.max(0, Math.min(100, fallbackValue));
  }
  const weightById: Record<MeshBuildStage["id"], number> = {
    queued: 6,
    materializing: 22,
    preparing_domain: 45,
    meshing: 72,
    postprocessing: 88,
    ready: 100,
    failed: 100,
  };
  let active = 0;
  for (const stage of stages) {
    if (stage.status === "done" || stage.status === "warning" || stage.status === "active") {
      active = Math.max(active, weightById[stage.id]);
    }
  }
  return active;
}

export function deriveEffectiveMeshTargets(args: {
  sceneDocument: SceneDocument | null;
  meshOptions: MeshOptionsState;
}): EffectiveMeshTarget[] {
  const { sceneDocument, meshOptions } = args;
  return (sceneDocument?.objects ?? []).map((object) => {
    const override = object.mesh_override;
    const isCustom = override?.mode === "custom";
    const inheritedHmax = meshOptions.hmax.trim().length > 0 ? Number(meshOptions.hmax) : null;
    const inheritedHmin = meshOptions.hmin.trim().length > 0 ? Number(meshOptions.hmin) : null;
    const overrideHmax =
      isCustom && override?.hmax && override.hmax.trim().length > 0 ? Number(override.hmax) : null;
    const overrideHmin =
      isCustom && override?.hmin && override.hmin.trim().length > 0 ? Number(override.hmin) : null;
    return {
      geometryName: object.name,
      source: isCustom ? "local_override" : "study_default",
      hmax: Number.isFinite(overrideHmax ?? NaN) ? overrideHmax : inheritedHmax,
      hmin: Number.isFinite(overrideHmin ?? NaN) ? overrideHmin : inheritedHmin,
      algorithm2d: isCustom ? (override?.algorithm_2d ?? meshOptions.algorithm2d) : meshOptions.algorithm2d,
      algorithm3d: isCustom ? (override?.algorithm_3d ?? meshOptions.algorithm3d) : meshOptions.algorithm3d,
    };
  });
}

function lastMatchingLog(
  engineLog: EngineLogEntry[],
  patterns: string[],
): EngineLogEntry | null {
  for (let index = engineLog.length - 1; index >= 0; index -= 1) {
    const entry = engineLog[index];
    const lower = entry.message.toLowerCase();
    if (patterns.some((pattern) => lower.includes(pattern))) {
      return entry;
    }
  }
  return null;
}

function hasAnyLog(engineLog: EngineLogEntry[], patterns: string[]): boolean {
  return lastMatchingLog(engineLog, patterns) != null;
}

export function estimateDenseSolverRamGb(nodeCount: number): number {
  return (nodeCount * nodeCount * 24) / 1e9;
}

export function extractMeshLogHighlights(
  engineLog: EngineLogEntry[],
  limit = 6,
): EngineLogEntry[] {
  const keywords = [
    "mesh",
    "remesh",
    "gmsh",
    "stl",
    "classif",
    "tetra",
    "quality",
    "coarsen",
    "optimiz",
    "surface",
    "geometry",
  ];
  return engineLog
    .filter((entry) => {
      const lower = entry.message.toLowerCase();
      return keywords.some((keyword) => lower.includes(keyword));
    })
    .slice(-limit)
    .reverse();
}

export function buildMeshPipelinePhases(args: {
  engineLog: EngineLogEntry[];
  meshSource: string | null;
  nodeCount: number;
  elementCount: number;
  meshOptions: MeshOptionsState;
  meshQualityData: MeshQualityData | null;
  workspaceStatus: string;
}): MeshPipelinePhaseStatus[] {
  const {
    engineLog,
    meshSource,
    nodeCount,
    elementCount,
    meshOptions,
    meshQualityData,
    workspaceStatus,
  } = args;

  const importEntry = lastMatchingLog(engineLog, [
    "importing stl surface",
    "loading python script",
    "preparing fem mesh asset",
    "remesh requested",
  ]);
  const classifyEntry = lastMatchingLog(engineLog, [
    "classifying stl surfaces",
    "creating geometry from classified surfaces",
  ]);
  const generateEntry = lastMatchingLog(engineLog, [
    "generating 3d tetrahedral mesh",
    "remesh complete",
    "mesh ready",
    "fem mesh ready",
  ]);
  const optimizeEntry = lastMatchingLog(engineLog, [
    "auto-coarsen",
    "optimiz",
    "smoothing",
    "relocate",
    "netgen",
    "laplace",
  ]);
  const qualityEntry = lastMatchingLog(engineLog, [
    "extracting quality metrics",
    "quality metrics",
    "sicn",
    "gamma",
  ]);
  const readinessEntry = lastMatchingLog(engineLog, [
    "est. ram",
    "available ram",
    "too large",
    "oom",
    "waiting for compute",
    "compute requested",
  ]);

  const optimizeRequested = meshOptions.optimize !== "" || meshOptions.smoothingSteps > 0;
  const qualityRequested = meshOptions.computeQuality;
  const readinessRamGb = nodeCount > 0 ? estimateDenseSolverRamGb(nodeCount) : 0;
  const readinessWarning = nodeCount > 50_000;
  const readinessLarge = nodeCount > 10_000;

  return [
    {
      id: "import",
      label: "Import",
      status: meshSource || importEntry ? "done" : "idle",
      detail: meshSource ?? importEntry?.message ?? "Waiting for source geometry",
    },
    {
      id: "classify",
      label: "Classify",
      status: classifyEntry || elementCount > 0 ? "done" : (importEntry ? "active" : "idle"),
      detail:
        classifyEntry?.message ??
        (elementCount > 0 ? "Surface classification completed during volume meshing" : "Surface healing / classification pending"),
    },
    {
      id: "generate",
      label: "Generate",
      status: elementCount > 0 || generateEntry ? "done" : (classifyEntry ? "active" : "idle"),
      detail:
        generateEntry?.message ??
        (elementCount > 0 ? `${nodeCount.toLocaleString()} nodes, ${elementCount.toLocaleString()} tetrahedra` : "Volume generation pending"),
    },
    {
      id: "optimize",
      label: "Optimize",
      status:
        optimizeEntry
          ? "done"
          : optimizeRequested
            ? "active"
            : "idle",
      detail:
        optimizeEntry?.message ??
        (optimizeRequested
          ? `Method ${meshOptions.optimize || "smoothing"} · ${meshOptions.smoothingSteps} smoothing step(s)`
          : "No optimizer policy enabled"),
    },
    {
      id: "quality",
      label: "Quality",
      status:
        meshQualityData
          ? "done"
          : qualityEntry
            ? "done"
            : qualityRequested
              ? "active"
              : "idle",
      detail:
        meshQualityData
          ? `SICN p5 ${meshQualityData.sicnP5.toFixed(3)} · gamma min ${meshQualityData.gammaMin.toFixed(3)}`
          : qualityEntry?.message ??
            (qualityRequested ? "Quality extraction requested for next remesh" : "Quality extraction disabled"),
    },
    {
      id: "readiness",
      label: "Solver Readiness",
      status:
        readinessWarning
          ? "warning"
          : readinessLarge
            ? "active"
            : (nodeCount > 0 || workspaceStatus === "waiting_for_compute" || hasAnyLog(engineLog, ["waiting for compute"]))
              ? "done"
              : "idle",
      detail:
        readinessEntry?.message ??
        (nodeCount > 0
          ? `${nodeCount.toLocaleString()} nodes · est. dense solver RAM ${readinessRamGb.toFixed(1)} GB`
          : "Mesh not ready for solver checks"),
    },
  ];
}

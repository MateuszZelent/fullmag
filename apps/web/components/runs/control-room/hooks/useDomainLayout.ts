import { useMemo } from "react";

import type { ActivityInfo } from "../types";
import type {
  DomainFrameState,
  FemLiveMesh,
  LiveState,
  MeshSummaryState,
  ScriptBuilderGeometryEntry,
  ScriptBuilderCurrentModuleEntry,
  ScriptBuilderState,
  ScriptBuilderUniverseState,
  MeshWorkspaceState,
  SpatialPreviewState,
} from "../../../../lib/session/types";
import type {
  CapabilityMap,
  GpuTelemetryDevice,
  GpuTelemetryResponse,
} from "../../../../src/api/types";
import { isFemDiscretization } from "@/src/domain/capabilities";
import type { AntennaOverlay, BuilderObjectOverlay } from "../shared";
import {
  asVec3,
  boundsCenter,
  boundsExtent,
  buildObjectOverlays,
  combineBounds,
  fmtSI,
  materializationProgressFromMessage,
  parseStageExecutionMessage,
} from "../shared";
import { runtimeEngineGpuLabelForDevice } from "../controlRoomUtils";

export interface UseDomainLayoutParams {
  latestEngineMessage: string | null;
  workspaceStatus: string | null;
  isFemBackend: boolean;
  domainCapabilities?: CapabilityMap | null;
  effectiveStep: number;
  effectiveTime: number;
  runtimeEngineLabel: string | null;
  runtimeEngineDeviceName: string | null;
  session: { requested_backend?: string; interactive_session_requested?: boolean } | null;
  gpuTelemetry: GpuTelemetryResponse | null;
  metadata: Record<string, unknown> | null;
  femMesh: FemLiveMesh | null;
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[];
  scriptBuilderUniverse: ScriptBuilderUniverseState | null;
  scriptBuilderCurrentModules: ScriptBuilderCurrentModuleEntry[];
  meshWorkspace: MeshWorkspaceState | null;
  liveState: LiveState | null;
  latestFieldGrid: [number, number, number] | null;
  spatialPreview: SpatialPreviewState | null;
  scriptBuilder: ScriptBuilderState | null;
  runtimeStatus: { can_accept_commands?: boolean } | null;
  isWaitingForCompute: boolean;
}

export interface UseDomainLayoutReturn {
  currentStage: { kind: string; current: number; total: number } | null;
  activity: ActivityInfo;
  runtimeEngineGpuDevice: GpuTelemetryDevice | null;
  runtimeEngineGpuLabel: string | null;
  artifactLayout: Record<string, unknown> | undefined;
  meshBoundsMin: [number, number, number] | null;
  meshBoundsMax: [number, number, number] | null;
  meshExtent: [number, number, number] | null;
  meshName: string | null;
  meshSource: string | null;
  meshFeOrder: number | null;
  meshHmax: number | null;
  meshSummary: MeshSummaryState | null;
  liveMeshName: string | null;
  builderObjectOverlays: BuilderObjectOverlay[];
  builderObjectBounds: { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null;
  domainFrame: DomainFrameState | null;
  worldExtent: [number, number, number] | null;
  worldCenter: [number, number, number] | null;
  worldExtentSource: string | null;
  antennaOverlays: AntennaOverlay[];
  meshingCapabilities: Record<string, unknown> | undefined;
  mesherBackend: string | null;
  mesherSourceKind: string | null;
  mesherCurrentSettings: Record<string, unknown> | null;
  solverGrid: [number, number, number];
  previewGrid: [number, number, number];
  totalCells: number | null;
  activeCells: number | null;
  inactiveCells: number | null;
  activeMaskPresent: boolean;
  activeMask: boolean[] | null;
  interactiveEnabled: boolean;
  awaitingCommand: boolean;
  runtimeCanAcceptCommands: boolean;
  interactiveControlsEnabled: boolean;
}

export function useDomainLayout(params: UseDomainLayoutParams): UseDomainLayoutReturn {
  const {
    latestEngineMessage,
    workspaceStatus,
    isFemBackend,
    domainCapabilities,
    effectiveStep,
    effectiveTime,
    runtimeEngineLabel,
    runtimeEngineDeviceName,
    session,
    gpuTelemetry,
    metadata,
    femMesh,
    scriptBuilderGeometries,
    scriptBuilderUniverse,
    scriptBuilderCurrentModules,
    meshWorkspace,
    liveState,
    latestFieldGrid,
    spatialPreview,
    scriptBuilder,
    runtimeStatus,
    isWaitingForCompute,
  } = params;
  const femDiscretization = domainCapabilities
    ? isFemDiscretization(domainCapabilities)
    : isFemBackend;

  const currentStage = useMemo(() => parseStageExecutionMessage(latestEngineMessage), [latestEngineMessage]);

  const activity = useMemo<ActivityInfo>(() => {
    if (workspaceStatus === "materializing_script") {
      const pv = materializationProgressFromMessage(latestEngineMessage);
      const lowerMessage = (latestEngineMessage ?? "").toLowerCase();
      const hasGmshPercent = /\[\s*\d{1,3}%\]/.test(latestEngineMessage ?? "");
      const isLong = lowerMessage.includes("generating 3d tetrahedral mesh") && !hasGmshPercent;
      return { label: femDiscretization ? "Materializing FEM workspace" : "Materializing workspace",
               detail: latestEngineMessage ?? "Preparing geometry import and execution plan",
               progressMode: isLong ? "indeterminate" : "determinate", progressValue: pv };
    }
    if (workspaceStatus === "bootstrapping")
      return { label: "Bootstrapping workspace", detail: latestEngineMessage ?? "Starting local API and control room",
               progressMode: "indeterminate", progressValue: undefined };
    if (workspaceStatus === "running") {
      const sl = currentStage ? `Solving ${currentStage.kind} — stage ${currentStage.current}/${currentStage.total}` : "Running solver";
      return { label: sl, detail: effectiveStep > 0
        ? `Step ${effectiveStep.toLocaleString()} · t=${fmtSI(effectiveTime, "s")} · ${runtimeEngineLabel ?? session?.requested_backend?.toUpperCase() ?? "runtime"}`
        : latestEngineMessage ?? "Solver startup in progress", progressMode: "indeterminate", progressValue: undefined };
    }
    if (workspaceStatus === "paused")
      return { label: "Solver paused", detail: latestEngineMessage ?? "Interactive stage is paused and can be resumed",
               progressMode: "determinate", progressValue: 100 };
    if (workspaceStatus === "awaiting_command")
      return { label: "Interactive workspace ready", detail: latestEngineMessage ?? "Waiting for the next run or relax command",
               progressMode: "determinate", progressValue: 100 };
    if (workspaceStatus === "completed")
      return { label: "Run completed", detail: latestEngineMessage ?? "Solver finished successfully",
               progressMode: "determinate", progressValue: 100 };
    if (workspaceStatus === "failed")
      return { label: "Run failed", detail: latestEngineMessage ?? "Execution stopped with an error",
               progressMode: "determinate", progressValue: 100 };
    return { label: "Workspace idle", detail: latestEngineMessage ?? "No active task",
             progressMode: "idle", progressValue: undefined };
  }, [effectiveStep, effectiveTime, currentStage, femDiscretization, latestEngineMessage, runtimeEngineLabel, session?.requested_backend, workspaceStatus]);

  const runtimeEngineGpuDevice = useMemo<GpuTelemetryDevice | null>(() => {
    const devices = gpuTelemetry?.devices ?? [];
    if (devices.length === 0) {
      return null;
    }
    if (runtimeEngineDeviceName) {
      const exact = devices.find((device) => device.name === runtimeEngineDeviceName);
      if (exact) {
        return exact;
      }
      const partial = devices.find((device) => runtimeEngineDeviceName.includes(device.name) || device.name.includes(runtimeEngineDeviceName));
      if (partial) {
        return partial;
      }
    }
    return [...devices].sort((left, right) => right.utilization_gpu_percent - left.utilization_gpu_percent)[0] ?? null;
  }, [gpuTelemetry, runtimeEngineDeviceName]);

  const runtimeEngineGpuLabel = useMemo(
    () => runtimeEngineGpuLabelForDevice(runtimeEngineGpuDevice),
    [runtimeEngineGpuDevice],
  );

  /* Artifact / execution plan metadata */
  const artifactLayout = (metadata?.artifact_layout as Record<string, unknown> | undefined) ?? undefined;
  const femArtifactLayout = artifactLayout?.backend === "fem" ? artifactLayout : undefined;
  const meshBoundsMin = asVec3(femArtifactLayout?.bounds_min) ?? asVec3(artifactLayout?.bounds_min);
  const meshBoundsMax = asVec3(femArtifactLayout?.bounds_max) ?? asVec3(artifactLayout?.bounds_max);
  const meshExtent =
    asVec3(femArtifactLayout?.mesh_extent)
    ?? asVec3(artifactLayout?.mesh_extent)
    ?? asVec3(femArtifactLayout?.world_extent)
    ?? asVec3(artifactLayout?.world_extent);
  const layoutWorldExtent =
    asVec3(femArtifactLayout?.world_extent) ?? asVec3(artifactLayout?.world_extent);
  const layoutWorldCenter =
    asVec3(femArtifactLayout?.world_center) ?? asVec3(artifactLayout?.world_center);
  const layoutWorldExtentSource =
    typeof femArtifactLayout?.world_extent_source === "string"
      ? femArtifactLayout.world_extent_source
      : (typeof artifactLayout?.world_extent_source === "string"
          ? artifactLayout.world_extent_source
          : null);
  const meshName = typeof femArtifactLayout?.mesh_name === "string" ? femArtifactLayout.mesh_name : null;
  const meshSource = typeof femArtifactLayout?.mesh_source === "string" ? femArtifactLayout.mesh_source : null;
  const meshFeOrder = typeof femArtifactLayout?.fe_order === "number" ? femArtifactLayout.fe_order : null;
  const meshHmax = typeof femArtifactLayout?.hmax === "number" ? femArtifactLayout.hmax : null;
  const meshSummary = meshWorkspace?.mesh_summary ?? null;
  const liveMeshName = typeof femMesh?.mesh_name === "string" ? femMesh.mesh_name : null;
  const liveMeshDomainFrame = femMesh?.domain_frame ?? null;
  const builderObjectOverlays = useMemo<BuilderObjectOverlay[]>(
    () => buildObjectOverlays(scriptBuilderGeometries, femMesh),
    [femMesh, scriptBuilderGeometries],
  );
  const builderObjectBounds = useMemo(
    () => combineBounds(builderObjectOverlays),
    [builderObjectOverlays],
  );
  const builderObjectExtent = useMemo<[number, number, number] | null>(
    () =>
      builderObjectBounds
        ? boundsExtent(builderObjectBounds.boundsMin, builderObjectBounds.boundsMax)
        : null,
    [builderObjectBounds],
  );
  const builderObjectCenter = useMemo<[number, number, number] | null>(
    () =>
      builderObjectBounds
        ? boundsCenter(builderObjectBounds.boundsMin, builderObjectBounds.boundsMax)
        : null,
    [builderObjectBounds],
  );
  const domainFrame = useMemo<DomainFrameState | null>(() => {
    if (!femDiscretization) {
      return null;
    }
    if (liveMeshDomainFrame) {
      return liveMeshDomainFrame;
    }
    const builderDomainFrame = scriptBuilder?.domain_frame ?? null;
    const meshDomainFrame = meshSummary?.domain_frame ?? null;
    if (meshDomainFrame) {
      return meshDomainFrame;
    }
    if (builderDomainFrame) {
      return builderDomainFrame;
    }
    if (
      !scriptBuilderUniverse
      && !builderObjectBounds
      && !layoutWorldExtent
      && !meshBoundsMin
      && !meshBoundsMax
    ) {
      return null;
    }
    return {
      declared_universe: scriptBuilderUniverse
        ? {
            mode: scriptBuilderUniverse.mode,
            size: scriptBuilderUniverse.size,
            center: scriptBuilderUniverse.center,
            padding: scriptBuilderUniverse.padding,
            airbox_hmax: scriptBuilderUniverse.airbox_hmax,
            airbox_hmin: scriptBuilderUniverse.airbox_hmin,
            airbox_growth_rate: scriptBuilderUniverse.airbox_growth_rate,
            airbox_grading: scriptBuilderUniverse.airbox_grading,
          }
        : null,
      object_bounds_min: builderObjectBounds?.boundsMin ?? null,
      object_bounds_max: builderObjectBounds?.boundsMax ?? null,
      mesh_bounds_min: meshBoundsMin ?? null,
      mesh_bounds_max: meshBoundsMax ?? null,
      effective_extent:
        scriptBuilderUniverse?.mode === "manual" && scriptBuilderUniverse.size
          ? scriptBuilderUniverse.size
          : scriptBuilderUniverse?.mode === "auto" && builderObjectExtent
            ? builderObjectExtent.map((component, index) =>
                component + 2 * (scriptBuilderUniverse.padding?.[index] ?? 0)
              ) as [number, number, number]
            : layoutWorldExtent ?? builderObjectExtent ?? null,
      effective_center:
        scriptBuilderUniverse?.center
        ?? builderObjectCenter
        ?? layoutWorldCenter
        ?? (meshBoundsMin && meshBoundsMax ? boundsCenter(meshBoundsMin, meshBoundsMax) : null),
      effective_source:
        scriptBuilderUniverse?.mode === "manual" && scriptBuilderUniverse.size
          ? "declared_universe_manual"
          : scriptBuilderUniverse?.mode === "auto" && builderObjectExtent
            ? (
                (scriptBuilderUniverse.padding ?? [0, 0, 0]).some(
                  (component) => Math.abs(component) > 0,
                )
                  ? "declared_universe_auto_padding"
                  : "object_union_bounds"
              )
            : layoutWorldExtentSource ?? (builderObjectExtent ? "object_union_bounds" : null),
    };
  }, [
    builderObjectBounds,
    builderObjectCenter,
    builderObjectExtent,
    femDiscretization,
    layoutWorldCenter,
    layoutWorldExtent,
    layoutWorldExtentSource,
    liveMeshDomainFrame,
    meshBoundsMax,
    meshBoundsMin,
    meshSummary?.domain_frame,
    scriptBuilder?.domain_frame,
    scriptBuilderUniverse,
  ]);

  /* Unified world extent (metres) for both FDM and FEM */
  const worldExtent = useMemo<[number, number, number] | null>(() => {
    if (femDiscretization) {
      return domainFrame?.effective_extent ?? null;
    }
    // FDM: compute from grid_cells × cell_size
    const gridCells = asVec3(artifactLayout?.grid_cells);
    const cellSize = asVec3(artifactLayout?.cell_size);
    if (gridCells && cellSize) {
      return [
        gridCells[0] * cellSize[0],
        gridCells[1] * cellSize[1],
        gridCells[2] * cellSize[2],
      ];
    }
    return null;
  }, [artifactLayout, domainFrame, femDiscretization]);
  const worldCenter = useMemo<[number, number, number] | null>(() => {
    if (femDiscretization) {
      return domainFrame?.effective_center ?? null;
    }
    return scriptBuilderUniverse?.center ?? null;
  }, [domainFrame, femDiscretization, scriptBuilderUniverse]);
  const worldExtentSource = useMemo<string | null>(() => {
    if (!femDiscretization) {
      return "fdm_grid";
    }
    return domainFrame?.effective_source ?? null;
  }, [domainFrame, femDiscretization]);
  const antennaOverlays = useMemo<AntennaOverlay[]>(() => {
    if (!meshBoundsMin || !meshBoundsMax || scriptBuilderCurrentModules.length === 0) {
      return [];
    }
    const centerX0 = 0.5 * (meshBoundsMin[0] + meshBoundsMax[0]);
    const centerY0 = 0.5 * (meshBoundsMin[1] + meshBoundsMax[1]);
    const topZ = meshBoundsMax[2];
    const num = (record: Record<string, unknown>, key: string, fallback: number) =>
      typeof record[key] === "number" ? Number(record[key]) : fallback;

    return scriptBuilderCurrentModules.flatMap((module) => {
      const params = module.antenna_params ?? {};
      const centerX = centerX0 + num(params, "center_x", 0);
      const centerY = centerY0 + num(params, "center_y", 0);
      const thickness = num(params, "thickness", 100e-9);
      const previewLength = num(params, "preview_length", 5e-6);
      const heightAboveMagnet = num(params, "height_above_magnet", 0);
      const zBottom = topZ + heightAboveMagnet;
      const zTop = zBottom + thickness;
      const yMin = centerY - previewLength * 0.5;
      const yMax = centerY + previewLength * 0.5;
      const conductors: AntennaOverlay["conductors"] = [];

      if (module.antenna_kind === "MicrostripAntenna") {
        const width = num(params, "width", 1e-6);
        conductors.push({
          id: `${module.name}:strip`,
          label: module.name,
          role: "strip",
          boundsMin: [centerX - width * 0.5, yMin, zBottom],
          boundsMax: [centerX + width * 0.5, yMax, zTop],
          currentA: module.drive.current_a,
        });
      } else if (module.antenna_kind === "CPWAntenna") {
        const signalWidth = num(params, "signal_width", 1e-6);
        const gap = num(params, "gap", 0.25e-6);
        const groundWidth = num(params, "ground_width", 1e-6);
        const groundOffset = 0.5 * signalWidth + gap + 0.5 * groundWidth;
        conductors.push({
          id: `${module.name}:signal`,
          label: `${module.name} signal`,
          role: "signal",
          boundsMin: [centerX - signalWidth * 0.5, yMin, zBottom],
          boundsMax: [centerX + signalWidth * 0.5, yMax, zTop],
          currentA: module.drive.current_a,
        });
        conductors.push({
          id: `${module.name}:ground_l`,
          label: `${module.name} ground`,
          role: "ground",
          boundsMin: [centerX - groundOffset - groundWidth * 0.5, yMin, zBottom],
          boundsMax: [centerX - groundOffset + groundWidth * 0.5, yMax, zTop],
          currentA: -0.5 * module.drive.current_a,
        });
        conductors.push({
          id: `${module.name}:ground_r`,
          label: `${module.name} ground`,
          role: "ground",
          boundsMin: [centerX + groundOffset - groundWidth * 0.5, yMin, zBottom],
          boundsMax: [centerX + groundOffset + groundWidth * 0.5, yMax, zTop],
          currentA: -0.5 * module.drive.current_a,
        });
      }

      if (conductors.length === 0) {
        return [];
      }
      return [{
        id: module.name,
        name: module.name,
        antennaKind: module.antenna_kind,
        solver: module.solver,
        conductors,
      }];
    });
  }, [meshBoundsMax, meshBoundsMin, scriptBuilderCurrentModules]);
  const meshingCapabilities = (metadata?.meshing_capabilities as Record<string, unknown> | undefined) ?? undefined;
  const mesherBackend = typeof meshingCapabilities?.backend === "string" ? meshingCapabilities.backend : null;
  const mesherSourceKind = typeof meshingCapabilities?.source_kind === "string" ? meshingCapabilities.source_kind : null;
  const mesherCurrentSettings = (meshingCapabilities?.current_settings as Record<string, unknown> | undefined) ?? null;

  /* Grid */
  const _rawSolverGrid = liveState?.grid ?? latestFieldGrid;
  const solverGrid = useMemo<[number, number, number]>(
    () => [_rawSolverGrid?.[0] ?? 0, _rawSolverGrid?.[1] ?? 0, _rawSolverGrid?.[2] ?? 0] as [number, number, number],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_rawSolverGrid?.[0], _rawSolverGrid?.[1], _rawSolverGrid?.[2]],
  );
  const _rawPreviewGrid =
    spatialPreview?.preview_grid ?? liveState?.preview_grid ?? latestFieldGrid ?? solverGrid;
  const previewGrid = useMemo<[number, number, number]>(
    () => [_rawPreviewGrid?.[0] ?? 0, _rawPreviewGrid?.[1] ?? 0, _rawPreviewGrid?.[2] ?? 0] as [number, number, number],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [_rawPreviewGrid?.[0], _rawPreviewGrid?.[1], _rawPreviewGrid?.[2]],
  );
  const totalCells = !femDiscretization ? solverGrid[0] * solverGrid[1] * solverGrid[2] : null;
  const activeCells = useMemo(() => {
    if (typeof artifactLayout?.active_cell_count === "number") return artifactLayout.active_cell_count;
    return totalCells;
  }, [artifactLayout, totalCells]);
  const inactiveCells = useMemo(() => {
    if (typeof artifactLayout?.inactive_cell_count === "number") return artifactLayout.inactive_cell_count;
    if (activeCells != null && totalCells != null) return Math.max(totalCells - activeCells, 0);
    return null;
  }, [activeCells, artifactLayout, totalCells]);
  const activeMaskPresent =
    artifactLayout?.active_mask_present === true || spatialPreview?.active_mask != null;
  const activeMask = useMemo<boolean[] | null>(() => {
    // Prefer live preview mask (resampled to preview grid) over static artifact layout mask.
    if (spatialPreview?.active_mask != null) return spatialPreview.active_mask;
    const raw = artifactLayout?.active_mask;
    if (!Array.isArray(raw)) return null;
    return raw.map((v: unknown) => Boolean(v));
  }, [spatialPreview?.active_mask, artifactLayout]);

  /* Interactive */
  const interactiveEnabled = session?.interactive_session_requested === true;
  const awaitingCommand = workspaceStatus === "awaiting_command";
  const runtimeCanAcceptCommands =
    runtimeStatus?.can_accept_commands ?? interactiveEnabled;
  const interactiveControlsEnabled =
    interactiveEnabled &&
    (awaitingCommand || isWaitingForCompute || workspaceStatus === "running" || workspaceStatus === "paused");

  return {
    currentStage,
    activity,
    runtimeEngineGpuDevice,
    runtimeEngineGpuLabel,
    artifactLayout,
    meshBoundsMin,
    meshBoundsMax,
    meshExtent,
    meshName,
    meshSource,
    meshFeOrder,
    meshHmax,
    meshSummary,
    liveMeshName,
    builderObjectOverlays,
    builderObjectBounds,
    domainFrame,
    worldExtent,
    worldCenter,
    worldExtentSource,
    antennaOverlays,
    meshingCapabilities,
    mesherBackend,
    mesherSourceKind,
    mesherCurrentSettings,
    solverGrid,
    previewGrid,
    totalCells,
    activeCells,
    inactiveCells,
    activeMaskPresent,
    activeMask,
    interactiveEnabled,
    awaitingCommand,
    runtimeCanAcceptCommands,
    interactiveControlsEnabled,
  };
}

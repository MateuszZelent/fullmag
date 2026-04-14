"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Eye,
  EyeOff,
  GitCommitHorizontal,
  Layers,
  Loader2,
  MemoryStick,
  Ruler,
  SplitSquareHorizontal,
  Triangle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  formatMetersTextAsNanometers,
  metersTextToNanometersInput,
  nanometersInputToMetersText,
} from "@/lib/units";

import MeshSettingsPanel, {
  DEFAULT_MESH_OPTIONS,
  type MeshOptionsState,
  type SizeFieldSpec,
} from "../MeshSettingsPanel";
import MeshSequenceEditor from "./MeshSequenceEditor";
import { useViewport, useCommand, useModel } from "../../runs/control-room/context-hooks";
import { type ViewportMode } from "../../runs/control-room/shared";
import { fmtExp, fmtSI } from "@/lib/format";
import {
  MESH_RENDER_MODE_OPTIONS,
  MESH_WORKSPACE_PRESETS,
  buildMeshPipelinePhases,
  estimateDenseSolverRamGb,
  extractMeshLogHighlights,
} from "../../runs/control-room/meshWorkspace";
import type { RenderMode } from "../../preview/FemMeshView3D";
import { TextField } from "../../ui/TextField";
import SelectField from "../../ui/SelectField";
import { Button } from "../../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import type {
  ScriptBuilderPerGeometryMeshEntry,
} from "../../../lib/session/types";
import { findSceneObjectByNodeId } from "./objectSelection";
import { MetricField, SidebarSection } from "./primitives";
import { HelpTip } from "../../ui/HelpTip";

/* ── Helpers ── */

function createInheritedMeshState(): ScriptBuilderPerGeometryMeshEntry {
  return {
    mode: "inherit",
    size_mode: "predefined",
    hmax: "",
    hmin: "",
    maximum_element_size: "",
    minimum_element_size: "",
    calibrate_for: null,
    size_preset: null,
    order: null,
    source: null,
    algorithm_2d: null,
    algorithm_3d: null,
    size_factor: null,
    size_from_curvature: null,
    curvature_factor: "",
    growth_rate: "",
    maximum_element_growth_rate: "",
    narrow_regions: null,
    narrow_region_resolution: "",
    resolved_size_from_curvature: null,
    resolved_narrow_regions: null,
    resolved_growth_rate: "",
    smoothing_steps: null,
    optimize: null,
    optimize_iterations: null,
    compute_quality: null,
    per_element_quality: null,
    bulk_hmax: null,
    bulk_hmin: null,
    interface_hmax: null,
    interface_thickness: null,
    transition_distance: null,
    transition_growth: null,
    boundary_layer_count: null,
    boundary_layer_thickness: null,
    boundary_layer_stretching: null,
    mesh_strategy: null,
    through_thickness_elements: null,
    through_thickness_distribution: null,
    through_thickness_element_ratio: null,
    through_thickness_symmetric: false,
    sweep_face_meshing: null,
    size_fields: [],
    operations: [],
    build_requested: false,
  };
}

function mapObjectMeshToOptions(
  mesh: ScriptBuilderPerGeometryMeshEntry | null | undefined,
  globalOptions: MeshOptionsState,
): MeshOptionsState {
  const effective = {
    ...DEFAULT_MESH_OPTIONS,
    ...globalOptions,
  };
  if (!mesh) {
    return effective;
  }
  return {
    ...effective,
    hmax:
      (mesh.maximum_element_size ?? mesh.hmax).trim().length > 0
        ? (mesh.maximum_element_size ?? mesh.hmax)
        : effective.hmax,
    hmin:
      (mesh.minimum_element_size ?? mesh.hmin).trim().length > 0
        ? (mesh.minimum_element_size ?? mesh.hmin)
        : effective.hmin,
    sizeControlMode: mesh.size_mode === "custom" ? "custom" : effective.sizeControlMode,
    calibrateFor:
      typeof mesh.calibrate_for === "string" && mesh.calibrate_for.trim().length > 0
        ? mesh.calibrate_for
        : effective.calibrateFor,
    sizePreset:
      typeof mesh.size_preset === "string" && mesh.size_preset.trim().length > 0
        ? mesh.size_preset
        : effective.sizePreset,
    maximumElementSize:
      (mesh.maximum_element_size ?? mesh.hmax).trim().length > 0
        ? (mesh.maximum_element_size ?? mesh.hmax)
        : effective.maximumElementSize,
    minimumElementSize:
      (mesh.minimum_element_size ?? mesh.hmin).trim().length > 0
        ? (mesh.minimum_element_size ?? mesh.hmin)
        : effective.minimumElementSize,
    algorithm2d: mesh.algorithm_2d ?? effective.algorithm2d,
    algorithm3d: mesh.algorithm_3d ?? effective.algorithm3d,
    sizeFactor: mesh.size_factor ?? effective.sizeFactor,
    sizeFromCurvature: mesh.size_from_curvature ?? effective.sizeFromCurvature,
    curvatureFactor:
      mesh.curvature_factor?.trim().length
        ? mesh.curvature_factor
        : effective.curvatureFactor,
    growthRate: mesh.growth_rate.trim().length > 0 ? mesh.growth_rate : effective.growthRate,
    maximumElementGrowthRate:
      mesh.maximum_element_growth_rate?.trim().length
        ? mesh.maximum_element_growth_rate
        : effective.maximumElementGrowthRate,
    narrowRegions: mesh.narrow_regions ?? effective.narrowRegions,
    narrowRegionResolution:
      mesh.narrow_region_resolution?.trim().length
        ? mesh.narrow_region_resolution
        : effective.narrowRegionResolution,
    resolvedSizeFromCurvature:
      mesh.resolved_size_from_curvature ?? effective.resolvedSizeFromCurvature,
    resolvedNarrowRegions: mesh.resolved_narrow_regions ?? effective.resolvedNarrowRegions,
    resolvedGrowthRate:
      mesh.resolved_growth_rate?.trim().length
        ? mesh.resolved_growth_rate
        : effective.resolvedGrowthRate,
    smoothingSteps: mesh.smoothing_steps ?? effective.smoothingSteps,
    optimize: mesh.optimize ?? effective.optimize,
    optimizeIters: mesh.optimize_iterations ?? effective.optimizeIters,
    computeQuality: mesh.compute_quality ?? effective.computeQuality,
    perElementQuality: mesh.per_element_quality ?? effective.perElementQuality,
    refinementZones:
      mesh.size_fields.length > 0
        ? mesh.size_fields.map((field) => ({
            kind: field.kind,
            params: field.params as Record<string, string | number | number[]>,
          }))
        : effective.refinementZones,
    adaptiveEnabled: effective.adaptiveEnabled,
    adaptivePolicy: effective.adaptivePolicy,
    adaptiveIndicator: effective.adaptiveIndicator,
    adaptiveTargetQuantity: effective.adaptiveTargetQuantity,
    adaptiveConvergenceMetric: effective.adaptiveConvergenceMetric,
    adaptiveTheta: effective.adaptiveTheta,
    adaptiveHMin: effective.adaptiveHMin,
    adaptiveHMax: effective.adaptiveHMax,
    adaptiveMaxPasses: effective.adaptiveMaxPasses,
    adaptiveErrorTolerance: effective.adaptiveErrorTolerance,
  };
}

function buildCustomMeshState(
  options: MeshOptionsState,
  current: ScriptBuilderPerGeometryMeshEntry | null | undefined,
  extras: {
    order: number | null;
    source: string | null;
    buildRequested: boolean;
    boundaryLayerCount?: number | null;
    boundaryLayerThickness?: string | null;
    boundaryLayerStretching?: number | null;
    meshStrategy?: string | null;
    throughThicknessElements?: number | null;
    throughThicknessDistribution?: string | null;
    throughThicknessElementRatio?: number | null;
    throughThicknessSymmetric?: boolean | null;
    sweepFaceMeshing?: string | null;
  },
): ScriptBuilderPerGeometryMeshEntry {
  return {
    mode: "custom",
    size_mode: options.sizeControlMode === "custom" ? "custom" : "predefined",
    hmax: options.hmax,
    hmin: options.hmin,
    maximum_element_size: options.maximumElementSize,
    minimum_element_size: options.minimumElementSize,
    calibrate_for: options.calibrateFor,
    size_preset: options.sizePreset,
    order: extras.order,
    source: extras.source,
    algorithm_2d: options.algorithm2d,
    algorithm_3d: options.algorithm3d,
    size_factor: options.sizeFactor,
    size_from_curvature: options.sizeFromCurvature,
    curvature_factor: options.curvatureFactor,
    growth_rate: options.growthRate,
    maximum_element_growth_rate: options.maximumElementGrowthRate,
    narrow_regions: options.narrowRegions,
    narrow_region_resolution: options.narrowRegionResolution,
    resolved_size_from_curvature: options.resolvedSizeFromCurvature ?? null,
    resolved_narrow_regions: options.resolvedNarrowRegions ?? null,
    resolved_growth_rate: options.resolvedGrowthRate ?? "",
    smoothing_steps: options.smoothingSteps,
    optimize: options.optimize.trim().length > 0 ? options.optimize : null,
    optimize_iterations: options.optimize.trim().length > 0 ? options.optimizeIters : 1,
    compute_quality: options.computeQuality,
    per_element_quality: options.perElementQuality,
    bulk_hmax: current?.bulk_hmax ?? null,
    bulk_hmin: current?.bulk_hmin ?? null,
    interface_hmax: current?.interface_hmax ?? null,
    interface_thickness: current?.interface_thickness ?? null,
    transition_distance: current?.transition_distance ?? null,
    transition_growth: current?.transition_growth ?? null,
    boundary_layer_count: extras.boundaryLayerCount ?? current?.boundary_layer_count ?? null,
    boundary_layer_thickness: extras.boundaryLayerThickness ?? current?.boundary_layer_thickness ?? null,
    boundary_layer_stretching: extras.boundaryLayerStretching ?? current?.boundary_layer_stretching ?? null,
    mesh_strategy: extras.meshStrategy ?? current?.mesh_strategy ?? null,
    through_thickness_elements: extras.throughThicknessElements ?? current?.through_thickness_elements ?? null,
    through_thickness_distribution: extras.throughThicknessDistribution ?? current?.through_thickness_distribution ?? null,
    through_thickness_element_ratio: extras.throughThicknessElementRatio ?? current?.through_thickness_element_ratio ?? null,
    through_thickness_symmetric: extras.throughThicknessSymmetric ?? current?.through_thickness_symmetric ?? false,
    sweep_face_meshing: extras.sweepFaceMeshing ?? current?.sweep_face_meshing ?? null,
    size_fields: options.refinementZones.map((field: SizeFieldSpec) => ({
      kind: field.kind,
      params: { ...field.params },
    })),
    operations: current?.operations ?? [],
    build_requested: extras.buildRequested,
  };
}

function objectMeshTabFromNodeId(nodeId?: string): string {
  if (!nodeId) return "override";
  if (nodeId.includes("mesh-view")) return "view";
  if (nodeId.includes("mesh-quality")) return "diagnostics";
  if (nodeId.includes("mesh-pipeline")) return "build";
  return "override";
}

function formatMeshSetting(value: string | null | undefined, fallback = "Inherited / Auto"): string {
  if (!value) return fallback;
  return value.trim().length > 0 ? value : fallback;
}

/* ── Component ── */

export default function ObjectMeshPanel({ nodeId }: { nodeId?: string }) {
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();
  /* Backward-compatible ctx composed from granular hooks */
  const ctx = { ...model, effectiveViewMode: viewport.effectiveViewMode, handleViewModeChange: viewport.handleViewModeChange, workspaceStatus: cmd.workspaceStatus, engineLog: cmd.engineLog, isWaitingForCompute: cmd.isWaitingForCompute, scriptSyncBusy: cmd.scriptSyncBusy, scriptSyncMessage: cmd.scriptSyncMessage };

  const { object: sceneObject, index: geoIndex } = useMemo(
    () => findSceneObjectByNodeId(nodeId, model.sceneDocument),
    [model.sceneDocument, nodeId],
  );
  const geo = useMemo(
    () =>
      sceneObject
        ? {
            name: sceneObject.name,
            geometry_kind: sceneObject.geometry.geometry_kind,
            mesh: sceneObject.mesh_override,
            bounds_min: sceneObject.geometry.bounds_min ?? null,
            bounds_max: sceneObject.geometry.bounds_max ?? null,
          }
        : null,
    [sceneObject],
  );

  const updateGeo = useCallback(
    (updater: (mesh: ScriptBuilderPerGeometryMeshEntry | null) => ScriptBuilderPerGeometryMeshEntry | null) => {
      if (geoIndex < 0) {
        return;
      }
      model.setSceneDocument((prev) => {
        if (!prev) {
          return prev;
        }
        const nextObjects = [...prev.objects];
        const target = nextObjects[geoIndex];
        if (target) {
          nextObjects[geoIndex] = {
            ...target,
            mesh_override: updater(target.mesh_override ?? null),
          };
        }
        return {
          ...prev,
          objects: nextObjects,
        };
      });
    },
    [geoIndex, model],
  );

  const mesh = geo?.mesh ?? createInheritedMeshState();
  const effectiveOptions = useMemo(
    () => mapObjectMeshToOptions(geo?.mesh, model.meshOptions),
    [geo?.mesh, model.meshOptions],
  );
  const effectiveOrder = mesh.order ?? model.meshFeOrder ?? null;
  const effectiveSource = mesh.source ?? model.meshSource ?? null;
  const sharedDomainMesh =
    ctx.effectiveFemMesh?.domain_mesh_mode === "shared_domain_mesh_with_air";
  const [activeTab, setActiveTab] = useState(() => objectMeshTabFromNodeId(nodeId));
  useEffect(() => {
    setActiveTab(objectMeshTabFromNodeId(nodeId));
  }, [nodeId]);
  /* ── Mesh workspace data from context ── */
  const {
    effectiveFemMesh,
    meshFeOrder,
    meshHmax,
    effectiveViewMode,
    handleViewModeChange,
    meshRenderMode,
    setMeshRenderMode,
    meshClipEnabled,
    setMeshClipEnabled,
    meshClipAxis,
    setMeshClipAxis,
    meshClipPos,
    setMeshClipPos,
    meshOpacity,
    setMeshOpacity,
    meshShowArrows,
    setMeshShowArrows,
    meshQualitySummary,
    meshQualityData,
    meshBoundsMin,
    meshBoundsMax,
    meshSource,
    workspaceStatus,
    engineLog,
    meshWorkspacePreset,
    meshWorkspace,
  } = ctx;

  const meshHighlights = useMemo(() => extractMeshLogHighlights(engineLog), [engineLog]);
  const estimatedRamGb = effectiveFemMesh ? estimateDenseSolverRamGb(effectiveFemMesh.nodes.length) : 0;
  const structuredQualitySummary = meshWorkspace?.mesh_quality_summary ?? null;
  const pipelinePhases = useMemo(
    () =>
      meshWorkspace?.mesh_pipeline_status?.length
        ? meshWorkspace.mesh_pipeline_status
        : buildMeshPipelinePhases({
            engineLog,
            meshSource: meshSource ?? null,
            nodeCount: effectiveFemMesh?.nodes.length ?? 0,
            elementCount: effectiveFemMesh?.elements.length ?? 0,
            meshOptions: ctx.meshOptions,
            meshQualityData,
            workspaceStatus,
          }),
    [ctx.meshOptions, effectiveFemMesh?.elements.length, effectiveFemMesh?.nodes.length, engineLog, meshQualityData, meshSource, meshWorkspace?.mesh_pipeline_status, workspaceStatus],
  );

  const boundsSummary = useMemo(() => {
    // Prefer per-object bounds from geometry entry
    const bMin = geo?.bounds_min ?? meshBoundsMin;
    const bMax = geo?.bounds_max ?? meshBoundsMax;
    if (!bMin || !bMax) return null;
    return {
      x: bMax[0] - bMin[0],
      y: bMax[1] - bMin[1],
      z: bMax[2] - bMin[2],
      bMin,
      bMax,
    };
  }, [geo?.bounds_min, geo?.bounds_max, meshBoundsMin, meshBoundsMax]);

  const viewportModes: ViewportMode[] = ["Mesh", "3D", "2D"];
  const effectiveHmaxDisplay = formatMeshSetting(
    formatMetersTextAsNanometers(
      mesh.mode === "custom" ? mesh.hmax : model.meshOptions.hmax,
      "Auto / Object defaults",
    ),
    "Auto / Object defaults",
  );
  const effectiveHminDisplay = formatMeshSetting(
    formatMetersTextAsNanometers(
      mesh.mode === "custom" ? mesh.hmin : model.meshOptions.hmin,
      "Auto / Object defaults",
    ),
    "Auto / Object defaults",
  );

  function getPhaseStyle(status: "idle" | "active" | "done" | "warning" | "queued" | "failed") {
    switch (status) {
      case "done":
        return { css: "border-success/30 bg-success/10 text-success", icon: <CheckCircle2 size={13} className="text-success" /> };
      case "active":
        return { css: "border-primary/40 bg-primary/10 text-primary shadow-[0_0_12px_rgba(59,130,246,0.15)]", icon: <Loader2 size={13} className="animate-spin text-primary" /> };
      case "queued":
        return { css: "border-info/30 bg-info/10 text-info", icon: <CircleDashed size={13} className="text-info" /> };
      case "failed":
      case "warning":
        return { css: "border-warning/30 bg-warning/10 text-warning", icon: <AlertTriangle size={13} className="text-warning" /> };
      default:
        return { css: "border-border/40 bg-background/40 backdrop-blur-sm text-muted-foreground", icon: <CircleDashed size={13} className="opacity-50" /> };
    }
  }

  /* ── No geometry selected ── */
  if (!geo) {
    return (
      <div className="flex flex-col gap-0 border-t border-border/20">
        <SidebarSection title="Object Mesh Override" defaultOpen={true}>
          <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2 text-xs text-muted-foreground">
            Select an object mesh node to edit its local override or inspect how it inherits the shared object defaults.
          </div>
        </SidebarSection>
      </div>
    );
  }

  /* ── Main render ── */
  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Object Mesh Override" defaultOpen={true}>
        <div className="flex flex-col gap-5">
          <div className="rounded-lg border border-border/40 bg-card/20 px-3 py-2.5">
            <div className="text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground">
              Local Object Override
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-foreground">{geo.name}</span>
              <span className="rounded-md border border-border/40 bg-background/40 px-2 py-0.5 text-[0.65rem] font-mono text-muted-foreground">
                {geo.geometry_kind}
              </span>
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col gap-3">
            <TabsList className="grid h-auto grid-cols-5 gap-1 rounded-xl bg-background/45 p-1">
              <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="override">Override</TabsTrigger>
              <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="effective">Effective</TabsTrigger>
              <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="view">View</TabsTrigger>
              <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="diagnostics">Diagnostics</TabsTrigger>
              <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="build">Build</TabsTrigger>
            </TabsList>

            <TabsContent value="override" className="mt-0">
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={mesh.mode === "inherit" ? "default" : "outline"}
                    size="sm"
                    onClick={() =>
                      updateGeo(() => createInheritedMeshState())
                    }
                  >
                    Use Object Defaults
                  </Button>
                  <Button
                    variant={mesh.mode === "custom" ? "default" : "outline"}
                    size="sm"
                    onClick={() =>
                      updateGeo((currentMesh) =>
                        buildCustomMeshState(
                          effectiveOptions,
                          currentMesh,
                          {
                            order: currentMesh?.order ?? model.meshFeOrder ?? null,
                            source: currentMesh?.source ?? model.meshSource ?? null,
                            buildRequested: currentMesh?.build_requested ?? false,
                          },
                        ),
                      )
                    }
                  >
                    Use Local Override
                  </Button>
                </div>

                <SelectField
                  label="Mesh Mode"
                  value={mesh.mode}
                  onchange={(value) =>
                    updateGeo((currentMesh) =>
                        value === "custom"
                          ? buildCustomMeshState(effectiveOptions, currentMesh, {
                              order: currentMesh?.order ?? model.meshFeOrder ?? null,
                              source: currentMesh?.source ?? model.meshSource ?? null,
                              buildRequested: currentMesh?.build_requested ?? false,
                            })
                          : createInheritedMeshState(),
                    )
                  }
                  options={[
                    { label: "Object Defaults", value: "inherit" },
                    { label: "Local Override", value: "custom" },
                  ]}
                  tooltip="Whether this object inherits the shared object defaults for the study-domain mesh or uses a custom local override."
                />

                {mesh.mode === "inherit" && (
                  <div className="rounded-lg border border-border/40 bg-card/30 px-3 py-2 text-xs text-muted-foreground">
                    This object currently inherits the shared object defaults for the study-domain rebuild.
                    Switch to custom mode to edit a local override for the next domain rebuild.
                  </div>
                )}
                {sharedDomainMesh ? (
                  <div className="rounded-lg border border-info/20 bg-info/10 px-3 py-2 text-xs text-info/90">
                    Shared-domain FEM uses one conformal solver mesh. This panel edits only this
                    object&apos;s local sizing override, but applying it rebuilds the full study-domain
                    mesh rather than an isolated object mesh.
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    key={`${geo.name}-mesh-order-${effectiveOrder ?? ""}`}
                    label="FEM Order"
                    defaultValue={effectiveOrder != null ? String(effectiveOrder) : ""}
                    onchange={(e) => {
                      const raw = e.target.value.trim();
                      updateGeo((currentMesh) =>
                        buildCustomMeshState(
                          effectiveOptions,
                          currentMesh,
                          {
                            order: raw.length > 0 ? Math.max(1, Math.round(Number(raw) || 1)) : null,
                            source: currentMesh?.source ?? model.meshSource ?? null,
                            buildRequested: currentMesh?.build_requested ?? false,
                          },
                        ),
                      );
                    }}
                    mono
                    disabled={mesh.mode !== "custom"}
                    placeholder="1"
                    tooltip="Finite element polynomial order (P1 = linear, P2 = quadratic)."
                  />
                  <TextField
                    key={`${geo.name}-mesh-source-${effectiveSource ?? ""}`}
                    label="Source Mesh"
                    defaultValue={effectiveSource ?? ""}
                    onchange={(e) => {
                      const raw = e.target.value.trim();
                      updateGeo((currentMesh) =>
                        buildCustomMeshState(
                          effectiveOptions,
                          currentMesh,
                          {
                            order: currentMesh?.order ?? model.meshFeOrder ?? null,
                            source: raw.length > 0 ? raw : null,
                            buildRequested: currentMesh?.build_requested ?? false,
                          },
                        ),
                      );
                    }}
                    mono
                    disabled={mesh.mode !== "custom"}
                    placeholder="mesh.msh"
                    tooltip="File path to a pre-generated mesh for this object. Leave empty to auto-generate."
                  />
                </div>

                <MeshSettingsPanel
                  options={effectiveOptions}
                  onChange={(nextOptions) =>
                    updateGeo((currentMesh) =>
                        mesh.mode === "custom"
                          ? buildCustomMeshState(nextOptions, currentMesh, {
                              order: currentMesh?.order ?? model.meshFeOrder ?? null,
                              source: currentMesh?.source ?? model.meshSource ?? null,
                              buildRequested: currentMesh?.build_requested ?? false,
                            })
                          : currentMesh ?? createInheritedMeshState(),
                    )
                  }
                  quality={meshQualityData}
                  generating={ctx.meshGenerating}
                  nodeCount={effectiveFemMesh?.nodes.length}
                  disabled={mesh.mode !== "custom" || ctx.meshGenerating}
                  waitMode={ctx.isWaitingForCompute}
                  showAdaptiveSection={false}
                />

                {/* ── Boundary Layers ── */}
                <div className="flex flex-col gap-2">
                  <div className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Boundary Layers
                  </div>
                  <div className="rounded-lg border border-border/30 bg-background/40 p-3 text-[0.72rem] text-muted-foreground">
                    Prismatic near-wall extrusion (Gmsh BoundaryLayer field). Leave blank to
                    disable.
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <TextField
                      label="Count"
                      defaultValue={mesh.boundary_layer_count != null ? String(mesh.boundary_layer_count) : ""}
                      onchange={(e) => {
                        const raw = e.target.value.trim();
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            boundaryLayerCount: raw.length > 0 ? Math.max(1, Math.round(Number(raw) || 1)) : null,
                          }),
                        );
                      }}
                      mono
                      disabled={mesh.mode !== "custom"}
                      placeholder="0 = off"
                      tooltip="Number of prismatic boundary-layer element rows near this object's walls."
                    />
                    <TextField
                      label="Thickness"
                      unit="nm"
                      defaultValue={metersTextToNanometersInput(mesh.boundary_layer_thickness ?? "")}
                      onchange={(e) => {
                        const raw = e.target.value.trim();
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            boundaryLayerThickness: raw.length > 0 ? nanometersInputToMetersText(raw) : null,
                          }),
                        );
                      }}
                      mono
                      disabled={mesh.mode !== "custom"}
                      placeholder="2"
                      tooltip="Target first-layer thickness in nanometres."
                    />
                    <TextField
                      label="Stretching"
                      defaultValue={mesh.boundary_layer_stretching != null ? String(mesh.boundary_layer_stretching) : ""}
                      onchange={(e) => {
                        const raw = e.target.value.trim();
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            boundaryLayerStretching: raw.length > 0 ? Number(raw) || null : null,
                          }),
                        );
                      }}
                      mono
                      disabled={mesh.mode !== "custom"}
                      placeholder="1.2"
                      tooltip="Layer growth ratio between successive boundary layer rows (1.0–2.0)."
                    />
                  </div>
                </div>

                {/* ── Swept / Through-Thickness ── */}
                <div className="flex flex-col gap-2">
                  <div className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Swept / Through-Thickness
                  </div>
                  <div className="rounded-lg border border-border/30 bg-background/40 p-3 text-[0.72rem] text-muted-foreground">
                    Extruded mesh for thin-film geometries. Set layer count to enable.
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <TextField
                      label="Layers"
                      defaultValue={mesh.through_thickness_elements != null ? String(mesh.through_thickness_elements) : ""}
                      onchange={(e) => {
                        const raw = e.target.value.trim();
                        const layers = raw.length > 0 ? Math.max(1, Math.round(Number(raw) || 1)) : null;
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            throughThicknessElements: layers,
                            meshStrategy: layers != null ? (cur?.mesh_strategy ?? "swept_prism") : null,
                          }),
                        );
                      }}
                      mono
                      disabled={mesh.mode !== "custom"}
                      placeholder="6"
                      tooltip="Number of element layers through the thin dimension."
                    />
                    <SelectField
                      label="Distribution"
                      value={mesh.through_thickness_distribution ?? "fixed"}
                      onchange={(val) =>
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            throughThicknessDistribution: val,
                          }),
                        )
                      }
                      options={[
                        { label: "Fixed", value: "fixed" },
                        { label: "Linear", value: "linear" },
                        { label: "Exponential", value: "exponential" },
                      ]}
                      disabled={mesh.mode !== "custom"}
                    />
                    <TextField
                      label="Ratio"
                      defaultValue={mesh.through_thickness_element_ratio != null ? String(mesh.through_thickness_element_ratio) : ""}
                      onchange={(e) => {
                        const raw = e.target.value.trim();
                        updateGeo((cur) =>
                          buildCustomMeshState(effectiveOptions, cur, {
                            order: cur?.order ?? model.meshFeOrder ?? null,
                            source: cur?.source ?? model.meshSource ?? null,
                            buildRequested: cur?.build_requested ?? false,
                            throughThicknessElementRatio: raw.length > 0 ? Number(raw) || null : null,
                          }),
                        );
                      }}
                      mono
                      disabled={mesh.mode !== "custom"}
                      placeholder="1.0"
                      tooltip="Ratio of last to first layer height for non-uniform distributions."
                    />
                  </div>
                </div>

                {/* ── Operation Sequence ── */}
                <div className="flex flex-col gap-2">
                  <div className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Mesh Operations
                  </div>
                  <MeshSequenceEditor
                    operations={mesh.operations}
                    onChange={(ops) =>
                      updateGeo((cur) => ({
                        ...(cur ?? createInheritedMeshState()),
                        mode: "custom",
                        operations: ops,
                      }))
                    }
                    disabled={mesh.mode !== "custom" || ctx.meshGenerating}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="effective" className="mt-0">
              <div className="flex flex-col gap-3">
                <div className="overflow-x-auto rounded-lg border border-border/40">
                  <table className="w-full text-[0.72rem]">
                    <thead>
                      <tr className="border-b border-border/30 bg-muted/20">
                        <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground uppercase tracking-widest text-[0.6rem]">Parameter</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground uppercase tracking-widest text-[0.6rem]">Object defaults</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-muted-foreground uppercase tracking-widest text-[0.6rem]">Object override</th>
                        <th className="px-2 py-1.5 text-right font-semibold text-primary/80 uppercase tracking-widest text-[0.6rem]">Effective</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                      {[
                        {
                          param: "hmax",
                          studyVal: formatMetersTextAsNanometers(model.meshOptions.hmax, "auto"),
                          overrideVal:
                            mesh.mode === "custom" && mesh.hmax.trim()
                              ? formatMetersTextAsNanometers(mesh.hmax, "—")
                              : "—",
                          effectiveVal: formatMetersTextAsNanometers(effectiveOptions.hmax, "auto"),
                          overrideActive: mesh.mode === "custom" && mesh.hmax.trim().length > 0,
                        },
                        {
                          param: "hmin",
                          studyVal: formatMetersTextAsNanometers(model.meshOptions.hmin, "auto"),
                          overrideVal:
                            mesh.mode === "custom" && mesh.hmin.trim()
                              ? formatMetersTextAsNanometers(mesh.hmin, "—")
                              : "—",
                          effectiveVal: formatMetersTextAsNanometers(effectiveOptions.hmin, "auto"),
                          overrideActive: mesh.mode === "custom" && mesh.hmin.trim().length > 0,
                        },
                        {
                          param: "FE order",
                          studyVal: model.meshFeOrder != null ? `P${model.meshFeOrder}` : "auto",
                          overrideVal: mesh.mode === "custom" && mesh.order != null ? `P${mesh.order}` : "—",
                          effectiveVal: effectiveOrder != null ? `P${effectiveOrder}` : "auto",
                          overrideActive: mesh.mode === "custom" && mesh.order != null,
                        },
                        {
                          param: "Algorithm 2D",
                          studyVal: String(model.meshOptions.algorithm2d),
                          overrideVal: mesh.mode === "custom" && mesh.algorithm_2d != null ? String(mesh.algorithm_2d) : "—",
                          effectiveVal: String(effectiveOptions.algorithm2d),
                          overrideActive: mesh.mode === "custom" && mesh.algorithm_2d != null,
                        },
                        {
                          param: "Optimize",
                          studyVal: model.meshOptions.optimize || "none",
                          overrideVal: "—",
                          effectiveVal: effectiveOptions.optimize || "none",
                          overrideActive: false,
                        },
                        {
                          param: "Quality metrics",
                          studyVal: model.meshOptions.computeQuality ? "on" : "off",
                          overrideVal: "—",
                          effectiveVal: effectiveOptions.computeQuality ? "on" : "off",
                          overrideActive: false,
                        },
                      ].map(({ param, studyVal, overrideVal, effectiveVal, overrideActive }) => (
                        <tr key={param} className={cn("transition-colors hover:bg-muted/10", overrideActive && "bg-warning/5")}>
                          <td className="px-2 py-1.5 font-medium text-muted-foreground">{param}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-foreground/70">{studyVal}</td>
                          <td className={cn("px-2 py-1.5 text-right font-mono", overrideActive ? "text-warning font-semibold" : "text-muted-foreground/40")}>{overrideVal}</td>
                          <td className="px-2 py-1.5 text-right font-mono text-primary font-semibold">{effectiveVal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <MetricField label="Mode" value={mesh.mode === "custom" ? "Local Override" : "Inherited Defaults"} />
                  <MetricField label="Build Target" value={sharedDomainMesh ? "Study Domain Mesh" : "Object Mesh"} />
                </div>
                <div className="rounded-lg border border-border/35 bg-background/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                  Effective values merge the shared object defaults with this object&apos;s local override. If the mode is <code className="font-mono text-foreground/80">inherit</code>, every field above comes from the shared defaults rather than a separate third mesh.
                </div>
              </div>
            </TabsContent>

            <TabsContent value="view" className="mt-0">
              <SidebarSection title="Inspect & Render" defaultOpen={true}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    Viewport
                    <HelpTip>Switch between Mesh wireframe view, 3D magnetization view, and 2D heatmap view.</HelpTip>
                  </span>
                  <span className="text-[0.65rem] font-mono text-muted-foreground/70">{meshRenderMode}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {viewportModes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className="appearance-none rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5 text-xs font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                      data-active={effectiveViewMode === mode}
                      onClick={() => handleViewModeChange(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {MESH_RENDER_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="appearance-none rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5 text-xs font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                      data-active={meshRenderMode === option.value}
                      onClick={() => setMeshRenderMode(option.value as RenderMode)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div className="mt-3 grid gap-3 @[900px]:grid-cols-2">
                  <div className="grid gap-2 rounded-lg border border-border/30 bg-background/50 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.7rem] font-semibold tracking-wide text-muted-foreground flex items-center gap-1">
                        Clip Plane
                        <HelpTip>Enable a clipping plane to see inside the volume mesh along a chosen axis.</HelpTip>
                      </span>
                      <button
                        type="button"
                        className="rounded-md border border-border/40 bg-background/70 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                        data-active={meshClipEnabled}
                        onClick={() => setMeshClipEnabled((current) => !current)}
                      >
                        {meshClipEnabled ? "On" : "Off"}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(["x", "y", "z"] as const).map((axis) => (
                        <button
                          key={axis}
                          type="button"
                          className="appearance-none rounded-md border border-border/40 bg-background/70 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                          data-active={meshClipAxis === axis}
                          disabled={!meshClipEnabled}
                          onClick={() => setMeshClipAxis(axis)}
                        >
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <label className="grid gap-1 text-[0.65rem] text-muted-foreground">
                      <span>Position: {Math.round(meshClipPos)}%</span>
                      <input
                        type="range"
                        className="h-[3px] w-full accent-primary"
                        min={0}
                        max={100}
                        value={meshClipPos}
                        onChange={(event) => setMeshClipPos(Number(event.target.value))}
                        disabled={!meshClipEnabled}
                      />
                    </label>
                  </div>

                  <div className="grid gap-2 rounded-lg border border-border/30 bg-background/50 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.7rem] font-semibold tracking-wide text-muted-foreground flex items-center gap-1">
                        Display
                        <HelpTip>Adjust mesh opacity and toggle magnetization arrows on the mesh surface.</HelpTip>
                      </span>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-md border border-border/40 bg-background/70 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                        data-active={meshShowArrows}
                        onClick={() => setMeshShowArrows((current) => !current)}
                      >
                        {meshShowArrows ? <Eye size={12} /> : <EyeOff size={12} />}
                        Arrows
                      </button>
                    </div>
                    <label className="grid gap-1 text-[0.65rem] text-muted-foreground">
                      <span>Opacity: {meshOpacity}%</span>
                      <input
                        type="range"
                        className="h-[3px] w-full accent-primary"
                        min={10}
                        max={100}
                        value={meshOpacity}
                        onChange={(event) => setMeshOpacity(Number(event.target.value))}
                      />
                    </label>
                  </div>
                </div>
              </SidebarSection>
            </TabsContent>

            <TabsContent value="diagnostics" className="mt-0">
              <SidebarSection title="Topology & Spatial" defaultOpen={true}>
                <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <GitCommitHorizontal size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Nodes</span>
            </div>
            <span className="font-mono text-xs font-semibold text-foreground/90">{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Triangle size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Elements</span>
            </div>
            <span className="font-mono text-xs font-semibold text-foreground/90">{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Layers size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Faces</span>
            </div>
            <span className="font-mono text-xs font-semibold text-foreground/90">{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
          </div>
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <SplitSquareHorizontal size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">FE Order</span>
            </div>
            <span className="font-mono text-xs font-semibold text-foreground/90">{meshFeOrder != null ? `P${meshFeOrder}` : "—"}</span>
          </div>
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Ruler size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Maximum Element Size</span>
            </div>
            <span className="font-mono text-xs font-semibold text-foreground/90">{meshHmax != null ? fmtSI(meshHmax, "m") : "—"}</span>
          </div>
          <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <MemoryStick size={11} />
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Dense RAM</span>
            </div>
            <span
              className={cn(
                "font-mono text-xs",
                (effectiveFemMesh?.nodes.length ?? 0) > 50_000
                  ? "text-error"
                  : (effectiveFemMesh?.nodes.length ?? 0) > 10_000
                    ? "text-warning"
                    : "text-success",
              )}
            >
              {effectiveFemMesh ? `${estimatedRamGb.toFixed(1)} GB` : "—"}
            </span>
          </div>
        </div>
        {boundsSummary && (
          <div className="mt-3 grid gap-1.5 rounded-lg border border-border/30 bg-background/50 p-2.5 text-xs text-foreground">
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Object</span>
              <span className="font-mono text-foreground">{geo.name}</span>
            </div>
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Extent</span>
              <span className="font-mono">
                {`x=${fmtSI(boundsSummary.x, "m")}  y=${fmtSI(boundsSummary.y, "m")}  z=${fmtSI(boundsSummary.z, "m")}`}
              </span>
            </div>
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Bounds</span>
              <span className="font-mono truncate" title={`${boundsSummary.bMin.join(", ")} -> ${boundsSummary.bMax.join(", ")}`}>
                {`${boundsSummary.bMin.map((value) => fmtExp(value)).join(", ")} → ${boundsSummary.bMax.map((value) => fmtExp(value)).join(", ")}`}
              </span>
            </div>
          </div>
        )}
              </SidebarSection>

              <SidebarSection title="Quality Snapshot" defaultOpen={false}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {meshQualityData ? "full metrics" : structuredQualitySummary ? "solver metrics" : meshQualitySummary ? "surface estimate" : "pending"}
          </span>
        </div>
        {meshQualityData ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.sicnP5.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.sicnMean.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Gamma Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.gammaMin.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Elements</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.nElements.toLocaleString()}</span>
            </div>
          </div>
        ) : structuredQualitySummary ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.sicn_p5.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.sicn_mean.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Gamma Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.gamma_min.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Avg Quality</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.avg_quality.toFixed(3)}</span>
            </div>
          </div>
        ) : meshQualitySummary ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">AR Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualitySummary.min.toFixed(2)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">AR Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualitySummary.mean.toFixed(2)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-success/10 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-success/80">Good Faces</span>
              <span className="font-mono text-xs font-semibold text-success">{meshQualitySummary.good.toLocaleString()}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-warning/10 backdrop-blur-sm px-2.5 py-2">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-warning/80">Poor Faces</span>
              <span className="font-mono text-xs font-semibold text-warning">{meshQualitySummary.poor.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/40 bg-background/30 px-3 py-2 text-[0.75rem] text-muted-foreground">
            Quality metrics not loaded yet. Use the global Optimize preset or enable Extract quality metrics before remeshing.
          </div>
        )}
              </SidebarSection>

              {/* ── Per-domain quality ── */}
              {effectiveFemMesh?.per_domain_quality && Object.keys(effectiveFemMesh.per_domain_quality).length > 0 && (
                <SidebarSection title="Per-Object Quality" defaultOpen={false}>
                  <div className="flex flex-col gap-2">
                    {Object.entries(effectiveFemMesh.per_domain_quality).map(([markerStr, q]) => {
                      const marker = Number(markerStr);
                      // Try to resolve geometry name from mesh_parts
                      const part = effectiveFemMesh.mesh_parts?.find(
                        (p) => p.role === "magnetic_object" && Number(p.element_start) <= marker,
                      );
                      const label = part?.object_id ?? part?.geometry_id ?? `Domain ${marker}`;
                      const sicnOk = q.sicn_p5 >= 0.1;
                      return (
                        <div key={markerStr} className="rounded-lg border border-border/35 bg-background/50 p-2.5">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-[0.72rem] font-semibold text-foreground/90">{label}</span>
                            <span className={cn(
                              "rounded-full px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider",
                              sicnOk
                                ? "bg-success/15 text-success"
                                : "bg-warning/15 text-warning",
                            )}>
                              {sicnOk ? "OK" : "WARN"}
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5 text-[0.68rem]">
                            <div className="grid gap-0.5">
                              <span className="font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
                              <span className="font-mono text-foreground/90">{q.sicn_p5.toFixed(3)}</span>
                            </div>
                            <div className="grid gap-0.5">
                              <span className="font-medium uppercase tracking-wider text-muted-foreground">SICN mean</span>
                              <span className="font-mono text-foreground/90">{q.sicn_mean.toFixed(3)}</span>
                            </div>
                            <div className="grid gap-0.5">
                              <span className="font-medium uppercase tracking-wider text-muted-foreground">Elements</span>
                              <span className="font-mono text-foreground/90">{q.n_elements.toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </SidebarSection>
              )}
            </TabsContent>

            <TabsContent value="build" className="mt-0">
              <SidebarSection title="Build" defaultOpen={true}>
                <div className="flex flex-col gap-3">
                  <div className="rounded-lg border border-border/35 bg-background/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                    {sharedDomainMesh
                      ? "Use Build Selected in the Mesh ribbon to sync this override, rebuild the study-domain mesh and open the build modal."
                      : "Use Build Selected in the Mesh ribbon to rebuild the active FEM mesh workflow from this object context."}
                  </div>
                  {ctx.meshConfigDirty && (
                    <div className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-[0.72rem] leading-relaxed text-warning/90">
                      This override is newer than the currently realized mesh. The 3D viewport still shows the last built mesh until you rebuild the study-domain mesh.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2">
                      <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                        Effective max size
                      </div>
                      <div className="mt-1 font-mono text-xs text-foreground">{effectiveHmaxDisplay}</div>
                    </div>
                    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2">
                      <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                        Effective min size
                      </div>
                      <div className="mt-1 font-mono text-xs text-foreground">{effectiveHminDisplay}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2">
                      <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                        Last build nodes
                      </div>
                      <div className="mt-1 font-mono text-xs text-foreground">
                        {meshWorkspace?.mesh_summary?.node_count?.toLocaleString() ?? "—"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2">
                      <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                        Elements
                      </div>
                      <div className="mt-1 font-mono text-xs text-foreground">
                        {meshWorkspace?.mesh_summary?.element_count?.toLocaleString() ?? "—"}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/30 bg-card/30 px-3 py-2">
                      <div className="text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                        Boundary faces
                      </div>
                      <div className="mt-1 font-mono text-xs text-foreground">
                        {meshWorkspace?.mesh_summary?.boundary_face_count?.toLocaleString() ?? "—"}
                      </div>
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/30 bg-card/30 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                    {ctx.meshGenerating || ctx.scriptSyncBusy
                      ? "Mesh build is currently active in the ribbon modal. You can keep editing overrides here or send the build to background from the dialog."
                      : (ctx.scriptSyncMessage
                        ?? "Ribbon-driven mesh build will sync the current scene document back to canonical Python, then queue a remesh with the latest local override.")}
                  </div>
                </div>
              </SidebarSection>

              <SidebarSection title="Pipeline Feedback" defaultOpen={false}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {meshHighlights.length} logs
          </span>
        </div>
        <div className="grid gap-2">
          {pipelinePhases.map((phase) => {
            const render = getPhaseStyle(phase.status);
            return (
              <div
                key={phase.id}
                className={cn("grid gap-1.5 rounded-xl border px-3 py-2.5 transition-colors", render.css)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    {render.icon}
                    <span className="text-[0.7rem] font-semibold tracking-wide">{phase.label}</span>
                  </div>
                  <span className="text-[0.62rem] font-mono tracking-widest opacity-70 uppercase">{phase.status}</span>
                </div>
                <div className="text-[0.74rem] leading-snug opacity-90">{phase.detail ?? "—"}</div>
              </div>
            );
          })}
        </div>
        {meshHighlights.length > 0 && (
          <div className="mt-2 grid gap-1 rounded-lg border border-border/30 bg-background/50 p-2.5">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Recent Mesh Log</span>
            <div className="grid gap-1">
              {meshHighlights.slice(0, 6).map((entry) => (
                <div key={`${entry.timestamp_unix_ms}:${entry.message}`} className="grid grid-cols-[56px_1fr] gap-2 text-[0.72rem]">
                  <span className="font-mono uppercase text-muted-foreground">{entry.level}</span>
                  <span className="text-foreground/90">{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
              </SidebarSection>

              <SidebarSection title="Workspace Presets" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          {MESH_WORKSPACE_PRESETS.map((preset) => {
            const active = meshWorkspacePreset === preset.id;
            const disabled = !effectiveFemMesh && preset.id !== "optimize";
            const Icon = preset.icon;
            return (
              <button
                key={preset.id}
                type="button"
                className={cn(
                  "flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-all",
                  active
                    ? "border-primary/40 bg-primary/10 shadow-[0_0_0_1px_rgba(59,130,246,0.1)]"
                    : "border-border/40 bg-background/50 hover:bg-muted/50 hover:border-border/80",
                  disabled && "cursor-not-allowed opacity-40 grayscale-[0.8]",
                )}
                disabled={disabled}
                onClick={() => ctx.applyMeshWorkspacePreset(preset.id)}
                title={preset.description}
              >
                <div className="flex items-center gap-1.5">
                  <Icon size={14} className={cn(active ? "text-primary" : "text-muted-foreground")} />
                  <span className={cn("text-[0.7rem] font-semibold tracking-wide", active ? "text-primary" : "text-foreground")}>
                    {preset.shortLabel}
                  </span>
                </div>
                <div className="text-[0.68rem] text-muted-foreground leading-snug line-clamp-2">{preset.description}</div>
              </button>
            );
          })}
        </div>
              </SidebarSection>
            </TabsContent>
          </Tabs>
        </div>
      </SidebarSection>
    </div>
  );
}

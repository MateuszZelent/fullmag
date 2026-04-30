"use client";

import { useMemo } from "react";

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
import {
  visualizationPatchForClip,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
} from "../../runs/control-room/visualizationStateSync";
import type { RenderMode } from "@/components/preview/FemMeshView3D";
import { Button } from "../../ui/button";

import { SidebarSection } from "./primitives";
import MeshManifestSection from "./MeshManifestSection";

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

export default function MeshPanel() {
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();

  const {
    effectiveViewMode,
    handleViewModeChange,
  } = viewport;

  const {
    workspaceStatus,
    engineLog,
  } = cmd;

  const {
    effectiveFemMesh,
    meshFeOrder,
    meshHmax,
    meshRenderMode,
    meshFaceDetail,
    meshSelection,
    setMeshSelection,
    meshWorkspacePreset,
    meshWorkspace,
    meshConfigDirty,
    meshClipEnabled,
    meshClipAxis,
    meshClipPos,
    meshOpacity,
    meshShowArrows,
    meshQualitySummary,
    meshQualityData,
    meshBoundsMin,
    meshBoundsMax,
    worldExtent,
    meshExtent,
    meshName,
    meshSource,
    mesherBackend,
    mesherSourceKind,
    meshOptions,
    applyMeshWorkspacePreset,
  } = model;

  const pipelinePhases =
    meshWorkspace?.mesh_pipeline_status?.length
      ? meshWorkspace.mesh_pipeline_status
      : buildMeshPipelinePhases({
          engineLog,
          meshSource,
          nodeCount: effectiveFemMesh?.nodes.length ?? 0,
          elementCount: effectiveFemMesh?.elements.length ?? 0,
          meshOptions: meshOptions,
          meshQualityData,
          workspaceStatus,
        });

  const meshHighlights = useMemo(() => extractMeshLogHighlights(engineLog), [engineLog]);
  const presetLabel =
    MESH_WORKSPACE_PRESETS.find((preset) => preset.id === meshWorkspacePreset)?.label ?? "Custom";
  const estimatedRamGb = effectiveFemMesh ? estimateDenseSolverRamGb(effectiveFemMesh.nodes.length) : 0;
  const structuredQualitySummary = meshWorkspace?.mesh_quality_summary ?? null;
  const meshCapabilities = meshWorkspace?.mesh_capabilities ?? null;
  const meshAdaptivity = meshWorkspace?.mesh_adaptivity_state ?? null;
  const adaptiveTargetSummary = meshAdaptivity?.last_target_h_summary ?? null;
  const adaptiveMetric = (key: string) => {
    const value = adaptiveTargetSummary?.[key];
    return typeof value === "number" ? value : null;
  };
  const adaptiveAction =
    adaptiveTargetSummary && typeof adaptiveTargetSummary.recommended_action === "string"
      ? adaptiveTargetSummary.recommended_action
      : null;

  const boundsSummary = useMemo(() => {
    if (!meshBoundsMin || !meshBoundsMax) return null;
    return {
      x: meshBoundsMax[0] - meshBoundsMin[0],
      y: meshBoundsMax[1] - meshBoundsMin[1],
      z: meshBoundsMax[2] - meshBoundsMin[2],
    };
  }, [meshBoundsMax, meshBoundsMin]);

  const viewportModes: ViewportMode[] = ["Mesh", "3D", "2D"];

  return (
    <div className="flex flex-col pt-4 px-2">
      <SidebarSection title="Mesh Semantics" defaultOpen={true}>
        <div className="rounded-xl border border-info/20 bg-info/10 px-3 py-3 text-[0.74rem] leading-relaxed text-info/90">
          This section shows the realized study-domain mesh. The size controls here are shared object defaults for future remeshes, not a third standalone mesh. Airbox sizing stays under Universe → Airbox.
        </div>
      </SidebarSection>

      {meshConfigDirty && (
        <SidebarSection title="Mesh Status" defaultOpen={true}>
          <div className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-3 text-[0.74rem] leading-relaxed text-warning/90">
            The viewport is still showing the last built mesh. You changed object-default, object-override or airbox parameters, so the realized 3D topology will refresh only after `Build Selected` or `Build All`.
          </div>
        </SidebarSection>
      )}

      <SidebarSection title="Environment Overview" defaultOpen={true}>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-lg border border-border/30 bg-card/30 p-2.5">
            <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">Backend</span>
            <span className="font-mono text-xs text-foreground">{mesherBackend ?? "—"}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/30 bg-card/30 p-2.5">
            <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">Source</span>
            <span className="font-mono text-xs text-foreground">{mesherSourceKind ?? meshSource ?? "—"}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/30 bg-card/30 p-2.5">
            <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">Workspace</span>
            <span className="font-mono text-xs text-foreground">{presetLabel}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border border-border/30 bg-card/30 p-2.5">
            <span className="text-[0.65rem] font-medium tracking-wide text-muted-foreground">Status</span>
            <span className="font-mono text-xs text-foreground">{workspaceStatus.replaceAll("_", " ")}</span>
          </div>
        </div>
      </SidebarSection>

      <MeshManifestSection
        manifest={meshWorkspace?.shared_domain_manifest ?? null}
        currentSceneRevision={model.sceneDocument?.revision ?? null}
      />

      <SidebarSection title="3D Mesh Display Presets" defaultOpen={true}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">{meshName ?? "mesh"}</span>
        </div>
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
                onClick={() => applyMeshWorkspacePreset(preset.id)}
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

      <SidebarSection title="Inspect & Render" defaultOpen={true}>
        <div className="mb-2 flex items-center justify-end">
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
        <div className="flex flex-wrap gap-1">
          {MESH_RENDER_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="appearance-none rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5 text-xs font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
              data-active={meshRenderMode === option.value}
              onClick={() => {
                void viewport.patchDisplay(visualizationPatchForRenderMode(option.value as RenderMode));
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 @[900px]:grid-cols-2">
          <div className="grid gap-2 rounded-lg border border-border/30 bg-background/50 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] font-semibold tracking-wide text-muted-foreground">Clip Plane</span>
              <button
                type="button"
                className="rounded-md border border-border/40 bg-background/70 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                data-active={meshClipEnabled}
                onClick={() => {
                  void viewport.patchDisplay(visualizationPatchForClip({ enabled: !meshClipEnabled }));
                }}
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
                  onClick={() => {
                    void viewport.patchDisplay(visualizationPatchForClip({ axis }));
                  }}
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
                onChange={(event) => {
                  void viewport.patchDisplay(
                    visualizationPatchForClip({ positionPercent: Number(event.target.value) }),
                  );
                }}
                disabled={!meshClipEnabled}
              />
            </label>
          </div>

          <div className="grid gap-2 rounded-lg border border-border/30 bg-background/50 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] font-semibold tracking-wide text-muted-foreground">Display</span>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-border/40 bg-background/70 px-2.5 py-1 text-[0.7rem] font-medium tracking-wide text-muted-foreground transition-colors hover:bg-muted/50 data-[active=true]:border-primary/50 data-[active=true]:bg-primary/20 data-[active=true]:text-primary"
                data-active={meshShowArrows}
                onClick={() => {
                  void viewport.patchDisplay({
                    layers: {
                      vectors: {
                        visible: !meshShowArrows,
                      },
                    },
                  });
                }}
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
                onChange={(event) => {
                  void viewport.patchDisplay(visualizationPatchForOpacity(Number(event.target.value)));
                }}
              />
            </label>
            <div className="text-[0.72rem] text-muted-foreground">
              Use `Inspect Volume` + `Clip` or `Slice Workspace` to verify that the STL was filled with tetrahedra inside.
            </div>
          </div>
        </div>
      </SidebarSection>

      <SidebarSection title="Topology & Solver Readiness" defaultOpen={true}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {effectiveFemMesh?.elements.length ? "volume mesh" : "surface preview"}
          </span>
        </div>
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
              <span className="text-[0.6rem] font-medium uppercase tracking-wider">Boundary Faces</span>
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
        {(boundsSummary || meshExtent || worldExtent) && (
          <div className="mt-3 grid gap-1.5 rounded-lg border border-border/30 bg-background/50 p-2.5 text-xs text-foreground">
            <div className="grid grid-cols-[96px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Extent</span>
              <span className="font-mono">
                {boundsSummary
                  ? `x=${fmtSI(boundsSummary.x, "m")}  y=${fmtSI(boundsSummary.y, "m")}  z=${fmtSI(boundsSummary.z, "m")}`
                  : "—"}
              </span>
            </div>
            <div className="grid grid-cols-[96px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Bounds</span>
              <span className="font-mono truncate" title={meshBoundsMin && meshBoundsMax ? `${meshBoundsMin.join(", ")} -> ${meshBoundsMax.join(", ")}` : ""}>
                {meshBoundsMin && meshBoundsMax
                  ? `${meshBoundsMin.map((value) => fmtExp(value)).join(", ")} -> ${meshBoundsMax.map((value) => fmtExp(value)).join(", ")}`
                  : "—"}
              </span>
            </div>
            <div className="grid grid-cols-[96px_1fr] gap-2">
              <span className="text-[0.65rem] font-bold uppercase text-muted-foreground">World</span>
              <span className="font-mono">
                {worldExtent
                  ? `x=${fmtSI(worldExtent[0], "m")}  y=${fmtSI(worldExtent[1], "m")}  z=${fmtSI(worldExtent[2], "m")}`
                  : "—"}
              </span>
            </div>
          </div>
        )}
      </SidebarSection>

      <SidebarSection title="Quality Snapshot" defaultOpen={true}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {meshQualityData ? "full metrics" : structuredQualitySummary ? "solver metrics" : meshQualitySummary ? "surface estimate" : "pending"}
          </span>
        </div>
        {meshQualityData ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.sicnP5.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.sicnMean.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Gamma Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.gammaMin.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Elements</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualityData.nElements.toLocaleString()}</span>
            </div>
          </div>
        ) : structuredQualitySummary ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.sicn_p5.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">SICN Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.sicn_mean.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Gamma Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.gamma_min.toFixed(3)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Avg Quality</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{structuredQualitySummary.avg_quality.toFixed(3)}</span>
            </div>
          </div>
        ) : meshQualitySummary ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">AR Min</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualitySummary.min.toFixed(2)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-background/60">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">AR Mean</span>
              <span className="font-mono text-xs font-semibold text-foreground/90">{meshQualitySummary.mean.toFixed(2)}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-success/10 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-success/15">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-success/80">Good Faces</span>
              <span className="font-mono text-xs font-semibold text-success">{meshQualitySummary.good.toLocaleString()}</span>
            </div>
            <div className="grid gap-1 rounded-xl border border-border/35 bg-warning/10 backdrop-blur-sm px-2.5 py-2 transition-colors hover:bg-warning/15">
              <span className="text-[0.6rem] font-medium uppercase tracking-wider text-warning/80">Poor Faces</span>
              <span className="font-mono text-xs font-semibold text-warning">{meshQualitySummary.poor.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/40 bg-background/30 px-3 py-2 text-[0.75rem] text-muted-foreground">
            Backend quality metrics are not loaded for this artifact. Open Mesh Statistics for topology fallback diagnostics, then rebuild the solver mesh to persist Gmsh quality metrics.
          </div>
        )}
      </SidebarSection>

      <SidebarSection title="Pipeline Feedback" defaultOpen={false}>
        <div className="mb-2 flex items-center justify-end">
          <span className="text-[0.65rem] font-mono text-muted-foreground/70">
            {meshWorkspace?.mesh_history?.length ?? 0} history · {meshHighlights.length} logs
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
        <div className="mt-2 grid gap-1 rounded-lg border border-border/30 bg-background/50 p-2.5">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Recent Mesh Log</span>
          {meshHighlights.length > 0 ? (
            <div className="grid gap-1">
              {meshHighlights.map((entry) => (
                <div key={`${entry.timestamp_unix_ms}:${entry.message}`} className="grid grid-cols-[56px_1fr] gap-2 text-[0.72rem]">
                  <span className="font-mono uppercase text-muted-foreground">{entry.level}</span>
                  <span className="text-foreground/90">{entry.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[0.74rem] text-muted-foreground">Mesh-specific backend events will appear here as soon as the pipeline emits them.</div>
          )}
        </div>
      </SidebarSection>

      {meshWorkspace?.mesh_history?.length ? (
        <SidebarSection title="Compare / History" defaultOpen={false}>
          <div className="mb-2 flex items-center justify-end">
            <span className="text-[0.65rem] font-mono text-muted-foreground/70">
              {meshWorkspace.mesh_history.length} snapshot{meshWorkspace.mesh_history.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid gap-2">
            {meshWorkspace.mesh_history.slice().reverse().slice(0, 4).map((entry, index) => (
              <div
                key={`${entry.mesh_name}-${entry.node_count}-${index}`}
                className="grid gap-1 rounded-lg border border-border/30 bg-background/50 p-2.5 text-[0.7rem]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{entry.mesh_name || "mesh"}</span>
                  <span className="font-mono text-muted-foreground">
                    {entry.generation_mode ?? entry.kind ?? "manual"}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {entry.node_count.toLocaleString()} nodes · {entry.element_count.toLocaleString()} tetra · {entry.boundary_face_count.toLocaleString()} faces
                </div>
              </div>
            ))}
          </div>
        </SidebarSection>
      ) : null}

      {(meshCapabilities || meshAdaptivity) ? (
        <SidebarSection title="Adaptivity & Capabilities" defaultOpen={false}>
          <div className="mb-2 flex items-center justify-end">
            <span className="text-[0.65rem] font-mono text-muted-foreground/70">
              {meshAdaptivity?.enabled ? meshAdaptivity.policy : "manual mesh"}
            </span>
          </div>
          {meshAdaptivity ? (
            <div className="grid gap-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 px-2.5 py-2">
                  <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Adaptive Mesh</span>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {meshAdaptivity.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 px-2.5 py-2">
                  <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Policy</span>
                  <span className="font-mono text-xs font-semibold text-foreground/90">{meshAdaptivity.policy}</span>
                </div>
                <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 px-2.5 py-2">
                  <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Pass Count</span>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {meshAdaptivity.pass_count} / {meshAdaptivity.max_passes}
                  </span>
                </div>
                <div className="grid gap-1 rounded-xl border border-border/35 bg-background/40 px-2.5 py-2">
                  <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Convergence</span>
                  <span className="font-mono text-xs font-semibold text-foreground/90">{meshAdaptivity.convergence_status}</span>
                </div>
              </div>
              {adaptiveTargetSummary ? (
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-primary/15 bg-primary/5 px-2.5 py-2.5">
                  <div className="grid gap-1 rounded-lg border border-border/30 bg-background/40 px-2 py-1.5">
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Target h min</span>
                    <span className="font-mono text-xs font-semibold text-foreground/90">
                      {adaptiveMetric("h_target_min") != null ? fmtSI(adaptiveMetric("h_target_min")!, "m") : "—"}
                    </span>
                  </div>
                  <div className="grid gap-1 rounded-lg border border-border/30 bg-background/40 px-2 py-1.5">
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Target h mean</span>
                    <span className="font-mono text-xs font-semibold text-foreground/90">
                      {adaptiveMetric("h_target_mean") != null ? fmtSI(adaptiveMetric("h_target_mean")!, "m") : "—"}
                    </span>
                  </div>
                  <div className="grid gap-1 rounded-lg border border-border/30 bg-background/40 px-2 py-1.5">
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Target h max</span>
                    <span className="font-mono text-xs font-semibold text-foreground/90">
                      {adaptiveMetric("h_target_max") != null ? fmtSI(adaptiveMetric("h_target_max")!, "m") : "—"}
                    </span>
                  </div>
                  <div className="grid gap-1 rounded-lg border border-border/30 bg-background/40 px-2 py-1.5">
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground">Recommended</span>
                    <span className="font-mono text-xs font-semibold text-foreground/90">{adaptiveAction ?? "—"}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {meshCapabilities ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                ["volume", meshCapabilities.has_volume_mesh],
                ["quality arrays", meshCapabilities.has_quality_arrays],
                ["adaptive remesh", meshCapabilities.supports_adaptive_remesh],
                ["compare", meshCapabilities.supports_compare_snapshots],
                ["size field", meshCapabilities.supports_size_field_remesh],
                ["mesh error", meshCapabilities.supports_mesh_error_preview],
                ["target_h", meshCapabilities.supports_target_h_preview],
              ].map(([label, enabled]) => (
                <span
                  key={String(label)}
                  className={cn(
                    "rounded-full border px-2 py-1 text-[0.62rem] font-bold uppercase tracking-widest",
                    enabled
                      ? "border-success/30 bg-success/10 text-success"
                      : "border-border/40 bg-background/50 text-muted-foreground",
                  )}
                >
                  {String(label)}
                </span>
              ))}
            </div>
          ) : null}
        </SidebarSection>
      ) : null}

      {/* ── Per-object quality summary ── */}
      {effectiveFemMesh?.per_domain_quality && Object.keys(effectiveFemMesh.per_domain_quality).length > 0 && (
        <SidebarSection title="Per-Object Quality" defaultOpen={false}>
          <div className="flex flex-col gap-2">
            {Object.entries(effectiveFemMesh.per_domain_quality).map(([markerStr, q]) => {
              const marker = Number(markerStr);
              const part = effectiveFemMesh.mesh_parts?.find(
                (p) => p.role === "magnetic_object",
              );
              const segment = effectiveFemMesh.object_segments?.find(
                (s) => s.element_start <= marker && marker < s.element_start + s.element_count,
              );
              const label = segment?.object_id ?? part?.object_id ?? `Domain ${marker}`;
              const sicnOk = q.sicn_p5 >= 0.1;
              return (
                <div key={markerStr} className="rounded-lg border border-border/35 bg-background/50 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[0.72rem] font-semibold text-foreground/90">{label}</span>
                    <span className={cn(
                      "rounded-full px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider",
                      sicnOk ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
                    )}>
                      {sicnOk ? "OK" : "WARN"}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-[0.68rem]">
                    <div className="grid gap-0.5">
                      <span className="font-medium uppercase tracking-wider text-muted-foreground">SICN p5</span>
                      <span className="font-mono text-foreground/90">{q.sicn_p5.toFixed(3)}</span>
                    </div>
                    <div className="grid gap-0.5">
                      <span className="font-medium uppercase tracking-wider text-muted-foreground">SICN mean</span>
                      <span className="font-mono text-foreground/90">{q.sicn_mean.toFixed(3)}</span>
                    </div>
                    <div className="grid gap-0.5">
                      <span className="font-medium uppercase tracking-wider text-muted-foreground">γ min</span>
                      <span className="font-mono text-foreground/90">{q.gamma_min.toFixed(3)}</span>
                    </div>
                    <div className="grid gap-0.5">
                      <span className="font-medium uppercase tracking-wider text-muted-foreground">Elems</span>
                      <span className="font-mono text-foreground/90">{q.n_elements.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SidebarSection>
      )}

      {meshFaceDetail && (
        <SidebarSection title="Selection" defaultOpen={true}>
          <div className="mb-2 flex items-center justify-end">
            <span className="text-[0.65rem] font-mono text-muted-foreground/70">
              {meshSelection.selectedFaceIndices.length} face{meshSelection.selectedFaceIndices.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid gap-1.5 rounded border border-border/30 bg-background/50 p-2 text-xs text-foreground">
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Face</span><span className="font-mono">#{meshFaceDetail.faceIndex}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Nodes</span><span className="font-mono truncate" title={meshFaceDetail.nodeIndices.join(", ")}>{meshFaceDetail.nodeIndices.join(", ")}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Area</span><span className="font-mono">{fmtExp(meshFaceDetail.area)} m²</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Perimeter</span><span className="font-mono">{fmtSI(meshFaceDetail.perimeter, "m")}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Aspect Ratio</span><span className="font-mono">{meshFaceDetail.aspectRatio.toFixed(2)}</span></div>
            <div className="grid grid-cols-[92px_1fr] gap-2"><span className="text-[0.65rem] font-bold uppercase text-muted-foreground">Centroid</span><span className="font-mono truncate" title={meshFaceDetail.centroid.map((value) => fmtExp(value)).join(", ")}>{meshFaceDetail.centroid.map((value) => fmtExp(value)).join(", ")}</span></div>
          </div>
          <div className="mt-3">
            <Button size="sm" variant="outline" className="w-full" onClick={() => setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null })}>
              Clear selection
            </Button>
          </div>
        </SidebarSection>
      )}
    </div>
  );
}

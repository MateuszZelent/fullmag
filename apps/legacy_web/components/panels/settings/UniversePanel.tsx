"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitCommitHorizontal, Layers, MemoryStick, Triangle } from "lucide-react";

import { useViewport, useCommand, useModel } from "../../runs/control-room/context-hooks";
import { useSelectionActions, useSelectionState } from "@/features/selection";
import { useViewportRenderState } from "@/features/visualization/hooks/useVizSlice";
import { defaultMeshEntityViewState, type ScriptBuilderUniverseState } from "../../../lib/session/types";
import { fmtSI } from "@/lib/format";
import SelectField from "../../ui/SelectField";
import { TextField } from "../../ui/TextField";
import { Button } from "../../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import MeshSettingsPanel from "../MeshSettingsPanel";
import { MetricField, InspectorSection, StatusBadge, ToggleRow, CompactInputGrid } from "./primitives";
import { resolveFemDiscretization } from "@/src/domain/capabilities";
import {
  humanizeToken,
  readBuilderContract,
} from "./helpers";

function formatVector(value: [number, number, number] | null, unit: string): string {
  if (!value) return "—";
  return value.map((component) => fmtSI(component, unit)).join(" · ");
}

function hasNonZeroVector(value: [number, number, number] | null): boolean {
  return Boolean(value && value.some((component) => Math.abs(component) > 0));
}

function estimateMeshPayloadBytes(
  nodeCount: number,
  elementCount: number,
  boundaryFaceCount: number,
): number {
  return (
    nodeCount * 3 * 8 +
    elementCount * 4 * 4 +
    elementCount * 4 +
    boundaryFaceCount * 3 * 4 +
    boundaryFaceCount * 4
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function meshPartRoleLabel(role: string): string {
  switch (role) {
    case "air":
      return "Air";
    case "magnetic_object":
      return "Object";
    case "interface":
      return "Interface";
    case "outer_boundary":
      return "Outer Boundary";
    default:
      return humanizeToken(role);
  }
}

function universeTabFromNodeId(nodeId: string): string {
  if (nodeId === "universe-boundary") return "boundary";
  if (
    nodeId === "universe-airbox"
    || nodeId === "universe-airbox-mesh"
  ) {
    return "airbox";
  }
  if (
    nodeId === "universe-mesh-view"
    || nodeId === "universe-mesh"
  ) {
    return "view";
  }
  if (
    nodeId === "universe-mesh-size"
    || nodeId === "universe-mesh-quality"
    || nodeId === "universe-mesh-pipeline"
  ) {
    return "build";
  }
  return "general";
}

export default function UniversePanel() {
  const viewport = useViewport();
  const cmd = useCommand();
  const model = useModel();
  const selection = useSelectionState();
  const selectionActions = useSelectionActions();
  const viz = useViewportRenderState();
  /* Compose a backward-compatible ctx alias from granular hooks */
  const ctx = {
    ...model,
    ...selection,
    ...selectionActions,
    setViewMode: viewport.setViewMode,
    handleViewModeChange: viewport.handleViewModeChange,
    metadata: cmd.metadata,
    isFemBackend: cmd.isFemBackend,
    domainCapabilities: cmd.domainCapabilities,
    commandStatus: cmd.commandStatus,
    session: cmd.session,
    commandMessage: cmd.commandMessage,
    scriptSyncBusy: cmd.scriptSyncBusy,
    scriptSyncMessage: cmd.scriptSyncMessage,
    syncScriptBuilder: cmd.syncScriptBuilder,
  };
  const femDiscretization = resolveFemDiscretization(ctx.domainCapabilities, false);
  const selectedNodeId = ctx.selectedSidebarNodeId ?? "universe";
  const builderContract = useMemo(() => readBuilderContract(ctx.metadata), [ctx.metadata]);
  const runtimeUniverse = useMemo<ScriptBuilderUniverseState | null>(() => {
    const declared = ctx.domainFrame?.declared_universe ?? null;
    if (!declared) return null;
    return {
      mode: declared.mode ?? "auto",
      size: declared.size ?? null,
      center: declared.center ?? null,
      padding: declared.padding ?? null,
      airbox_hmax: declared.airbox_hmax ?? null,
      airbox_hmin: declared.airbox_hmin ?? null,
      airbox_growth_rate: declared.airbox_growth_rate ?? null,
      airbox_grading: declared.airbox_grading ?? null,
    };
  }, [ctx.domainFrame?.declared_universe]);
  const builderUniverse = useMemo<ScriptBuilderUniverseState | null>(() => {
    if (ctx.scriptBuilderUniverse) return ctx.scriptBuilderUniverse;
    return runtimeUniverse;
  }, [ctx.scriptBuilderUniverse, runtimeUniverse]);
  const editable = Boolean(builderContract?.editableScopes.includes("universe"));

  const declaredSize = builderUniverse?.size ?? null;
  const worldExtent = ctx.worldExtent ?? declaredSize;
  const meshExtent = ctx.meshExtent ?? null;
  const center = builderUniverse?.center ?? ctx.worldCenter ?? null;
  const padding = builderUniverse?.padding ?? null;
  const effectiveAirboxHmax =
    ctx.scriptBuilderUniverse?.airbox_hmax ?? runtimeUniverse?.airbox_hmax ?? null;
  const outerBoundaryPolicy = ctx.scriptBuilderDemagRealization ?? "auto";
  const outerBoundaryLabel =
    outerBoundaryPolicy === "poisson_dirichlet" || outerBoundaryPolicy === "airbox_dirichlet"
      ? "Dirichlet"
      : outerBoundaryPolicy === "poisson_robin" || outerBoundaryPolicy === "airbox_robin"
        ? "Robin"
        : "Auto";
  const mode = builderUniverse?.mode ?? (worldExtent ? "derived" : null);
  const role = femDiscretization
    ? "Declared universe / workspace framing"
    : "FDM world box / grid domain";
  const sourceSummary = builderUniverse
    ? (femDiscretization
        ? "Universe/Airbox values below come directly from the active runtime domain frame and live mesh state."
        : "Universe values below come directly from the active runtime state.")
    : femDiscretization && ctx.worldExtentSource === "declared_universe_manual"
      ? "The current FEM world box comes from the active runtime domain frame."
    : femDiscretization && ctx.worldExtentSource === "object_union_bounds"
      ? `No explicit universe in the script yet; the control room is framing the FEM world from ${ctx.objectOverlays.length} object bounds.`
    : femDiscretization && ctx.worldExtentSource === "declared_universe_auto_padding"
        ? "No manual universe size in the script yet; the control room is deriving the world box from object bounds plus declared padding."
    : femDiscretization && ctx.worldExtentSource === "mesh_bounds"
      ? "Object bounds are not available, so the control room is falling back to the realized FEM mesh bounds for workspace framing."
    : femDiscretization && ctx.objectOverlays.length > 0
      ? `No explicit universe in the script yet; deriving the FEM world frame from ${ctx.objectOverlays.length} object bounds.`
    : worldExtent
      ? "No explicit universe in the script yet; using the current declared world/grid extent for control-room framing."
      : "Universe metadata is not available for this workspace yet.";

  const updateUniverse = useCallback(
    (updater: (current: ScriptBuilderUniverseState) => ScriptBuilderUniverseState) => {
      const seed: ScriptBuilderUniverseState = builderUniverse ?? runtimeUniverse ?? {
        mode: "auto",
        size: null,
        center: null,
        padding: null,
        airbox_hmax: null,
        airbox_hmin: null,
        airbox_growth_rate: null,
        airbox_grading: null,
      };
      ctx.setScriptBuilderUniverse((prev) => updater(prev ?? seed));
    },
    [builderUniverse, ctx, runtimeUniverse],
  );

  const updateVecComponent = useCallback(
    (
      field: "size" | "center" | "padding",
      index: number,
      valueRaw: string,
    ) => {
      const parsed = Number(valueRaw);
      if (!Number.isFinite(parsed)) return;
      updateUniverse((current) => {
        const next = current[field] ? [...current[field]] : [0, 0, 0];
        next[index] = parsed * 1e-9;
        return { ...current, [field]: next as [number, number, number] };
      });
    },
    [updateUniverse],
  );

  const formatNm = (value: number | null | undefined): string =>
    value == null || !Number.isFinite(value) ? "" : (value * 1e9).toFixed(1);
  const formatPercent = (value: number | null | undefined): string =>
    value == null || !Number.isFinite(value) ? "" : Math.round(value).toString();
  const updateEntityViewState = useCallback(
    (entityId: string, patch: Partial<(typeof ctx.meshEntityViewState)[string]>) => {
      ctx.setMeshEntityViewState((prev) => {
        const current = prev[entityId];
        if (!current) return prev;
        return { ...prev, [entityId]: { ...current, ...patch } };
      });
    },
    [ctx],
  );
  const airViewState = ctx.airPart ? ctx.meshEntityViewState[ctx.airPart.id] : null;
  const [activeTab, setActiveTab] = useState(() => universeTabFromNodeId(selectedNodeId));
  useEffect(() => {
    setActiveTab(universeTabFromNodeId(selectedNodeId));
  }, [selectedNodeId]);
  const meshSummary = ctx.meshWorkspace?.mesh_summary ?? null;
  const qualitySummary = ctx.meshWorkspace?.mesh_quality_summary ?? null;
  const payloadRamEstimate = formatBytes(
    estimateMeshPayloadBytes(
      meshSummary?.node_count ?? 0,
      meshSummary?.element_count ?? 0,
      meshSummary?.boundary_face_count ?? 0,
    ),
  );
  const handleIsolateAirboxView = useCallback(() => {
    ctx.handleViewModeChange("3D");
    ctx.setSelectedSidebarNodeId("universe-airbox");
    ctx.setSelectedObjectId(null);
    ctx.setViewportScope("universe");
    ctx.setObjectViewMode("context");
    void viewport.patchDisplay({
      layers: {
        airbox: {
          visible: true,
        },
      },
    });
    ctx.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of ctx.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = {
          ...current,
          visible: part.role === "air",
        };
      }
      return next;
    });
  }, [ctx, viewport]);
  const handleShowFullDomainView = useCallback(() => {
    ctx.handleViewModeChange("3D");
    ctx.setSelectedSidebarNodeId("universe-airbox");
    ctx.setSelectedObjectId(null);
    ctx.setViewportScope("universe");
    ctx.setObjectViewMode("context");
    void viewport.patchDisplay({
      layers: {
        airbox: {
          visible: false,
        },
      },
    });
    ctx.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of ctx.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = {
          ...current,
          visible: defaultMeshEntityViewState(part).visible,
        };
      }
      return next;
    });
  }, [ctx, viewport]);
  const airboxIsolated = useMemo(
    () =>
      Boolean(
        ctx.airPart &&
          ctx.meshParts.length > 0 &&
          ctx.meshParts.every((part) => {
            const visible =
              ctx.meshEntityViewState[part.id]?.visible ??
              defaultMeshEntityViewState(part).visible;
            return part.role === "air" ? visible : !visible;
          }),
      ),
    [ctx.airPart, ctx.meshEntityViewState, ctx.meshParts],
  );
  const showMeshPartsPanel =
    femDiscretization &&
    ctx.meshParts.length > 0;
  const handleIsolateMeshPart = useCallback(
    (partId: string) => {
      ctx.handleViewModeChange("3D");
      ctx.setSelectedSidebarNodeId("universe-airbox");
      ctx.setSelectedObjectId(null);
      ctx.setViewportScope("universe");
      ctx.setObjectViewMode("context");
      ctx.setSelectedEntityId(partId);
      ctx.setFocusedEntityId(partId);
      ctx.setMeshEntityViewState((prev) => {
        const next = { ...prev };
        for (const part of ctx.meshParts) {
          const current = next[part.id];
          if (!current) continue;
          next[part.id] = {
            ...current,
            visible: part.id === partId,
          };
        }
        return next;
      });
    },
    [ctx],
  );
  const handleShowAllMeshParts = useCallback(() => {
    ctx.handleViewModeChange("3D");
    ctx.setSelectedSidebarNodeId("universe-airbox");
    ctx.setSelectedObjectId(null);
    ctx.setViewportScope("universe");
    ctx.setObjectViewMode("context");
    ctx.setSelectedEntityId(null);
    ctx.setFocusedEntityId(null);
    ctx.setMeshEntityViewState((prev) => {
      const next = { ...prev };
      for (const part of ctx.meshParts) {
        const current = next[part.id];
        if (!current) continue;
        next[part.id] = {
          ...current,
          visible: defaultMeshEntityViewState(part).visible,
        };
      }
      return next;
    });
  }, [ctx]);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col gap-3 pt-4 px-2">
      <TabsList className="grid h-auto grid-cols-5 gap-1 rounded-xl bg-card/40 p-1">
        <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="general">General</TabsTrigger>
        <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="airbox" disabled={!femDiscretization}>Airbox</TabsTrigger>
        <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="view" disabled={!femDiscretization}>View</TabsTrigger>
        <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="boundary" disabled={!femDiscretization}>Boundary</TabsTrigger>
        <TabsTrigger className="min-h-[36px] text-[0.7rem] font-semibold normal-case tracking-normal" value="build" disabled={!femDiscretization}>Build</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="mt-0">
        <InspectorSection title="General Properties" defaultOpen={true}>
          <div className="flex flex-col gap-2">
            {editable && builderUniverse ? (
              <SelectField
                label="Universe Mode"
                value={builderUniverse.mode}
                onchange={(value) => updateUniverse((current) => ({ ...current, mode: value }))}
                options={[
                  { value: "auto", label: "Auto-fit" },
                  { value: "manual", label: "Manual" },
                ]}
                tooltip="Determines how the simulation bounds are established. Auto-fit tightly envelops all defined geometry objects. Manual requires explicit size definitions."
              />
            ) : (
              <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                {sourceSummary}
              </div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80 min-w-[4.5rem]">
                Backend
              </span>
              <StatusBadge label={femDiscretization ? "FEM" : "FDM"} tone="accent" />
            </div>
          </div>
        </InspectorSection>

        <InspectorSection title="Domain Extent" defaultOpen={true}>
          {editable && builderUniverse ? (
            <div className="flex flex-col gap-3">
              <CompactInputGrid
                label="Size (nm)"
                fields={[
                  { label: "X", value: formatNm(builderUniverse.size?.[0]), onChange: (v) => updateVecComponent("size", 0, v), disabled: builderUniverse.mode !== "manual" },
                  { label: "Y", value: formatNm(builderUniverse.size?.[1]), onChange: (v) => updateVecComponent("size", 1, v), disabled: builderUniverse.mode !== "manual" },
                  { label: "Z", value: formatNm(builderUniverse.size?.[2]), onChange: (v) => updateVecComponent("size", 2, v), disabled: builderUniverse.mode !== "manual" },
                ]}
              />
              <CompactInputGrid
                label="Center (nm)"
                fields={[
                  { label: "X", value: formatNm(builderUniverse.center?.[0]), onChange: (v) => updateVecComponent("center", 0, v) },
                  { label: "Y", value: formatNm(builderUniverse.center?.[1]), onChange: (v) => updateVecComponent("center", 1, v) },
                  { label: "Z", value: formatNm(builderUniverse.center?.[2]), onChange: (v) => updateVecComponent("center", 2, v) },
                ]}
              />
              <CompactInputGrid
                label="Padding (nm)"
                fields={[
                  { label: "X", value: formatNm(builderUniverse.padding?.[0]), onChange: (v) => updateVecComponent("padding", 0, v) },
                  { label: "Y", value: formatNm(builderUniverse.padding?.[1]), onChange: (v) => updateVecComponent("padding", 1, v) },
                  { label: "Z", value: formatNm(builderUniverse.padding?.[2]), onChange: (v) => updateVecComponent("padding", 2, v) },
                ]}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
              Universe extent is read-only in this context.
            </div>
          )}
        </InspectorSection>

        {femDiscretization ? (
          <InspectorSection title="Domain Mesh" defaultOpen={true}>
            <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
              The shared-domain FEM path now treats Universe mesh controls as domain-level diagnostics.
              Tune air-region density in the <span className="font-medium text-foreground">Airbox</span> tab
              and per-object sizing in each object&apos;s <span className="font-medium text-foreground">Mesh</span> panel.
            </div>
          </InspectorSection>
        ) : null}

        <InspectorSection title="Universe Summary" defaultOpen={true}>
          <div className="grid grid-cols-2 gap-3">
            <MetricField label="Mode" value={mode ? humanizeToken(mode) : "—"} tooltip="Current universe derivation mode." />
            <MetricField label="Role" value={role} tooltip="How this box should be interpreted in the active backend." />
            <MetricField label="Declared Size" value={formatVector(declaredSize, "m")} tooltip="Size explicitly declared in the builder." />
            <MetricField label="World Extent" value={formatVector(worldExtent, "m")} tooltip="Declared or derived workspace/world framing used by the control room." />
            <MetricField label="Mesh Extent" value={formatVector(meshExtent, "m")} tooltip="Bounding-box extent of the currently realized mesh." />
            <MetricField label="Center" value={formatVector(center, "m")} tooltip="Absolute origin of the universe bounding box." />
            <MetricField
              label="Padding"
              value={hasNonZeroVector(padding) ? formatVector(padding, "m") : "—"}
              tooltip="Calculated padding added around physical objects."
            />
          </div>
        </InspectorSection>
      </TabsContent>

      <TabsContent value="airbox" className="mt-0">
        {femDiscretization ? (
          <InspectorSection title="Airbox" defaultOpen={true}>
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-info/20 bg-info/10 p-2.5 text-[0.68rem] leading-relaxed text-info/90">
                Shared-domain FEM builds one conformal solver mesh for the airbox and magnetic bodies.
                `Airbox Hmax` steers the air-region density, while interfaces still refine around the magnetic geometry.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  key={`airbox-hmax-${effectiveAirboxHmax ?? "auto"}`}
                  label="Airbox Hmax (nm)"
                  defaultValue={formatNm(effectiveAirboxHmax)}
                  onBlur={(event) => {
                    if (!editable) return;
                    const value = event.target.value;
                    const trimmed = value.trim();
                    if (trimmed.length === 0) {
                      updateUniverse((current) => ({ ...current, airbox_hmax: null }));
                      return;
                    }
                    const parsed = Number(trimmed);
                    if (!Number.isFinite(parsed) || parsed <= 0) return;
                    updateUniverse((current) => ({
                      ...current,
                      airbox_hmax: parsed * 1e-9,
                    }));
                  }}
                  disabled={!editable}
                  tooltip="Live runtime maximum tetrahedron size for the airbox region. Leave blank to keep automatic grading."
                />
                <MetricField
                  label="Airbox Nodes"
                  value={ctx.airPart ? ctx.airPart.node_count.toLocaleString() : "—"}
                  tooltip="Current node count in the airbox partition of the realized shared-domain mesh."
                />
                <MetricField
                  label="Airbox Elements"
                  value={ctx.airPart ? ctx.airPart.element_count.toLocaleString() : "—"}
                  tooltip="Current tetrahedron count in the airbox partition of the realized shared-domain mesh."
                />
                <TextField
                  key={`airbox-opacity-${viz.airMeshOpacity}`}
                  label="Airbox Opacity (%)"
                  defaultValue={formatPercent(viz.airMeshOpacity)}
                  onBlur={(event) => {
                    const parsed = Number(event.target.value);
                    if (!Number.isFinite(parsed)) return;
                    void viewport.patchDisplay({
                      layers: {
                        airbox: {
                          opacity: Math.max(5, Math.min(100, Math.round(parsed))) / 100,
                        },
                      },
                    });
                  }}
                  tooltip="Viewport-only opacity for the Universe / airbox mesh in FEM domain view."
                />
              </div>
              <ToggleRow
                label="Show Airbox Mesh"
                checked={viz.airMeshVisible}
                onChange={(visible) => {
                  void viewport.patchDisplay({
                    layers: {
                      airbox: {
                        visible,
                      },
                    },
                  });
                }}
              />
              {airViewState ? (
                <SelectField
                  label="Airbox Style"
                  value={airViewState.renderMode}
                  onchange={(value) =>
                    updateEntityViewState(ctx.airPart!.id, {
                      renderMode: value as typeof airViewState.renderMode,
                    })}
                  options={[
                    { value: "wireframe", label: "Wireframe" },
                    { value: "surface", label: "Surface" },
                    { value: "surface+edges", label: "Surface + Edges" },
                    { value: "points", label: "Points" },
                  ]}
                />
              ) : null}
              <div className="rounded-lg border border-border/10 bg-card/40 p-3">
                <div className="mb-2 text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
                  Shared-Domain Mesher Policy
                </div>
                <div className="mb-3 text-[0.68rem] leading-relaxed text-muted-foreground">
                  These settings constrain the final shared-domain FEM solver mesh. `Airbox Hmax`
                  above controls only the air region, while the settings below come from the active
                  runtime mesher policy and affect the conformal rebuild for airbox plus magnetic
                  bodies.
                </div>
                <MeshSettingsPanel
                  options={ctx.meshOptions}
                  onChange={ctx.setMeshOptions}
                  quality={ctx.meshQualityData}
                  generating={ctx.meshGenerating}
                  disabled={ctx.meshGenerating}
                  nodeCount={meshSummary?.node_count ?? ctx.effectiveFemMesh?.nodes.length}
                  showAdaptiveSection={false}
                  capabilities={ctx.meshWorkspace?.mesh_capabilities ?? null}
                />
              </div>
            </div>
          </InspectorSection>
        ) : null}
      </TabsContent>

      <TabsContent value="view" className="mt-0">
        {femDiscretization ? (
          <>
            <InspectorSection title="View" defaultOpen={true}>
              <div className="rounded-lg border border-border/10 bg-card/40 p-3">
                <div className="mb-2 text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
                  Viewport
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={airboxIsolated ? "default" : "outline"}
                    onClick={handleIsolateAirboxView}
                  >
                    Isolate Airbox
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={!airboxIsolated ? "default" : "outline"}
                    onClick={handleShowFullDomainView}
                  >
                    Show Full Domain
                  </Button>
                </div>
                <div className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
                  `Isolate Airbox` hides magnetic-body mesh parts only in the 3D viewport, so you can inspect the air region by itself without changing the solver mesh.
                </div>
              </div>
            </InspectorSection>

            {showMeshPartsPanel ? (
              <InspectorSection title="Mesh Parts" defaultOpen={true}>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between rounded-lg border border-border/10 bg-card/40 p-2.5">
                    <div className="text-[0.68rem] leading-relaxed text-muted-foreground">
                      Shared-domain viewport renders canonical mesh parts directly from the realized FEM mesh.
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleShowAllMeshParts}
                    >
                      Show All
                    </Button>
                  </div>
                  {ctx.meshParts.map((part) => {
                    const viewState = ctx.meshEntityViewState[part.id];
                    const visible = viewState?.visible ?? defaultMeshEntityViewState(part).visible;
                    const opacity = viewState?.opacity ?? (part.role === "air" ? 28 : 100);
                    const renderMode = viewState?.renderMode ?? (part.role === "air" ? "wireframe" : "surface+edges");
                    return (
                      <div
                        key={part.id}
                        className="rounded-lg border border-border/10 bg-card/40 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">
                              {part.label || part.id}
                            </div>
                            <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                              {meshPartRoleLabel(part.role)}
                              {part.object_id ? ` · ${part.object_id}` : ""}
                            </div>
                          </div>
                          <StatusBadge
                            label={visible ? "Visible" : "Hidden"}
                            tone={visible ? "accent" : "default"}
                          />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[0.68rem] text-muted-foreground">
                          <div>Tetrahedra: {part.element_count.toLocaleString()}</div>
                          <div>Boundary faces: {part.boundary_face_count.toLocaleString()}</div>
                          <div>Nodes: {part.node_count.toLocaleString()}</div>
                          <div>Opacity: {opacity}%</div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={visible ? "outline" : "default"}
                            onClick={() => updateEntityViewState(part.id, { visible: !visible })}
                          >
                            {visible ? "Hide" : "Show"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleIsolateMeshPart(part.id)}
                          >
                            Isolate
                          </Button>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <SelectField
                            label="Style"
                            value={renderMode}
                            onchange={(value) =>
                              updateEntityViewState(part.id, {
                                renderMode: value as typeof renderMode,
                              })}
                            options={[
                              { value: "wireframe", label: "Wireframe" },
                              { value: "surface", label: "Surface" },
                              { value: "surface+edges", label: "Surface + Edges" },
                              { value: "points", label: "Points" },
                            ]}
                          />
                          <TextField
                            key={`mesh-part-opacity-${part.id}-${opacity}`}
                            label="Opacity (%)"
                            defaultValue={String(opacity)}
                            onBlur={(event) => {
                              const parsed = Number(event.target.value);
                              if (!Number.isFinite(parsed)) return;
                              updateEntityViewState(part.id, {
                                opacity: Math.max(5, Math.min(100, Math.round(parsed))),
                              });
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </InspectorSection>
            ) : null}
          </>
        ) : null}
      </TabsContent>

      <TabsContent value="boundary" className="mt-0">
        {femDiscretization ? (
          <InspectorSection title="Outer Boundary" defaultOpen={true}>
            <div className="flex flex-col gap-3">
              <SelectField
                label="BC Kind"
                value={outerBoundaryPolicy}
                onchange={(nextValue) => {
                  ctx.setScriptBuilderDemagRealization(
                    nextValue === "auto" ? null : nextValue,
                  );
                }}
                disabled={!editable}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "poisson_dirichlet", label: "Dirichlet" },
                  { value: "poisson_robin", label: "Robin" },
                ]}
              />
              <MetricField
                label="Status"
                value={outerBoundaryPolicy === "auto" ? "Planner-managed" : "Explicit authoring"}
              />
              <MetricField label="Effective" value={outerBoundaryLabel} />
              <div className="rounded-lg border border-border/10 bg-card/40 p-3 text-[0.72rem] leading-relaxed text-muted-foreground">
                `Dirichlet` and `Robin` keep demag on the shared airbox FEM path.
                Use a shared-domain mesh with air for executable FEM demag.
              </div>
            </div>
          </InspectorSection>
        ) : null}
      </TabsContent>

      <TabsContent value="build" className="mt-0">
        {femDiscretization ? (
          <InspectorSection title="Build & Log" defaultOpen={true}>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1 rounded border border-border/10 bg-card/40 px-2.5 py-2 transition-colors hover:bg-card/60">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <GitCommitHorizontal size={11} />
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider">Solver Nodes</span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {meshSummary?.node_count.toLocaleString() ?? "—"}
                  </span>
                </div>
                <div className="grid gap-1 rounded border border-border/10 bg-card/40 px-2.5 py-2 transition-colors hover:bg-card/60">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Triangle size={11} />
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider">Tetrahedra</span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {meshSummary?.element_count.toLocaleString() ?? "—"}
                  </span>
                </div>
                <div className="grid gap-1 rounded border border-border/10 bg-card/40 px-2.5 py-2 transition-colors hover:bg-card/60">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Layers size={11} />
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider">Boundary Faces</span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {meshSummary?.boundary_face_count.toLocaleString() ?? "—"}
                  </span>
                </div>
                <div className="grid gap-1 rounded border border-border/10 bg-card/40 px-2.5 py-2 transition-colors hover:bg-card/60">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <MemoryStick size={11} />
                    <span className="text-[0.6rem] font-medium uppercase tracking-wider">Payload RAM</span>
                  </div>
                  <span className="font-mono text-xs font-semibold text-foreground/90">
                    {payloadRamEstimate}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-3 rounded border border-border/10 bg-card/40 p-3 shadow-sm transition-all duration-300">
                <div className="rounded border border-info/20 bg-info/10 px-3 py-2.5 text-[0.72rem] leading-relaxed text-info/90">
                  Use the Mesh ribbon to launch `Build Selected` for the airbox or `Build All` for the full study-domain mesh. The build modal now owns progress, logs and pipeline feedback.
                </div>
                {ctx.meshConfigDirty && (
                  <div className="rounded border border-warning/25 bg-warning/10 px-3 py-2.5 text-[0.72rem] leading-relaxed text-warning/90">
                    Airbox or mesh settings changed after the last build. The 3D viewport still shows the last built mesh until you rebuild.
                  </div>
                )}
                <div className="rounded-md border border-border/10 bg-card/40 px-2.5 py-2 text-[0.68rem] leading-relaxed text-muted-foreground">
                  {ctx.commandMessage
                    ?? ctx.meshWorkspace?.last_build_error
                    ?? "Change airbox sizing here, then use the Mesh ribbon to sync the script, queue a study-domain remesh and follow the build in the modal."}
                  {qualitySummary
                    ? ` Current avg quality ${qualitySummary.avg_quality.toFixed(3)}.`
                    : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={ctx.scriptSyncBusy}
                  onClick={() => void ctx.syncScriptBuilder()}
                >
                  Sync Script
                </Button>
              </div>
              <div className="text-[0.68rem] text-muted-foreground">
                {ctx.scriptSyncMessage
                  ?? "Change airbox sizing here, then use `Build Selected` or `Build All` in the Mesh ribbon to sync the script, queue a study-domain remesh and follow the shared-domain status in the build modal."}
              </div>
            </div>
          </InspectorSection>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

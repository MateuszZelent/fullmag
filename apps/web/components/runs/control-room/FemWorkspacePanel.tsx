"use client";

import type { ReactNode } from "react";
import { Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import MeshSettingsPanel from "../../panels/MeshSettingsPanel";
import type { MeshOptionsState, MeshQualityData } from "../../panels/MeshSettingsPanel";
import type { ClipAxis, MeshSelectionSnapshot, RenderMode } from "../../preview/FemMeshView3D";
import type { FemLiveMesh } from "../../../lib/useSessionStream";
import { ViewportBar, ViewportCanvasArea } from "./ViewportPanels";
import {
  type FemDockTab,
  type MeshFaceDetail,
  type PreviewComponent,
  type VectorComponent,
  type ViewportMode,
  DockTabButton,
  PANEL_SIZES,
  fmtExp,
  fmtPreviewEveryN,
  fmtSI,
} from "./shared";

interface MesherSettings {
  order?: number;
  hmax?: number;
}

interface MeshQualitySummary {
  min: number;
  max: number;
  mean: number;
  good: number;
  fair: number;
  poor: number;
  count: number;
}

interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

import { useControlRoom } from "./ControlRoomContext";

export default function FemWorkspacePanel() {
  const ctx = useControlRoom();
  const {
    workspaceStatus,
    femDockTab,
    setFemDockTab,
    openFemMeshWorkspace,
    effectiveFemMesh,
    meshFeOrder,
    meshHmax,
    isMeshWorkspaceView,
    effectiveViewMode,
    handleViewModeChange,
    meshRenderMode,
    setMeshRenderMode,
    meshFaceDetail,
    meshSelection,
    setMeshSelection,
    meshName,
    meshSource,
    meshExtent,
    meshBoundsMin,
    meshBoundsMax,
    mesherBackend,
    mesherSourceKind,
    mesherCurrentSettings,
    meshOptions,
    setMeshOptions,
    meshQualityData,
    meshGenerating,
    handleMeshGenerate,
    previewControlsActive,
    requestedPreviewQuantity,
    previewQuantityOptions,
    previewBusy,
    updatePreview,
    setSelectedQuantity,
    requestedPreviewComponent,
    component,
    setComponent,
    requestedPreviewEveryN,
    previewEveryNOptions,
    meshOpacity,
    setMeshOpacity,
    meshShowArrows,
    setMeshShowArrows,
    meshClipEnabled,
    setMeshClipEnabled,
    meshClipAxis,
    setMeshClipAxis,
    meshClipPos,
    setMeshClipPos,
    meshQualitySummary,
  } = ctx;
  
  // Build local previewNotices (relocated from RunControlRoom for self-containment)
  const previewNotices = (
    <>
      {(ctx.preview?.auto_downscaled || ctx.liveState?.preview_auto_downscaled) && (
        <div
          className="px-2.5 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs leading-snug"
          title={ctx.preview?.auto_downscale_message ?? ctx.liveState?.preview_auto_downscale_message ?? undefined}
        >
          {ctx.preview?.auto_downscale_message ??
            ctx.liveState?.preview_auto_downscale_message ??
            `Preview auto-fit to ${ctx.previewGrid[0]}×${ctx.previewGrid[1]}×${ctx.previewGrid[2]}`}
        </div>
      )}
      {(ctx.previewMessage || ctx.previewIsStale || ctx.previewIsBootstrapStale) && (
        <div className="px-2.5 py-1.5 border-b border-border/40 bg-card/40 text-muted-foreground text-xs leading-snug">
          {ctx.previewMessage ??
            (ctx.previewIsBootstrapStale
              ? "Showing bootstrap preview until first live preview sample arrives"
              : "Preview update pending")}
        </div>
      )}
    </>
  );

  return (
    <>
      <Panel
        id="workspace-fem-dock"
        defaultSize={PANEL_SIZES.femDockDefault}
        minSize={PANEL_SIZES.femDockMin}
        maxSize={PANEL_SIZES.femDockMax}
      >
        <div className="flex flex-col h-full min-h-0 min-w-0 bg-gradient-to-b from-card/30 to-background border-r border-border/40">
        <div className="flex items-start justify-between gap-3 pt-3 px-3.5 pb-2.5 border-b border-border/40">
          <div>
            <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mesh Workspace</div>
            <div className="mt-0.5 text-base font-bold text-foreground">FEM Setup</div>
          </div>
          <span className="font-mono text-[0.65rem] uppercase tracking-widest text-muted-foreground data-[status=running]:text-primary data-[status=materializing_script]:text-amber-500" data-status={workspaceStatus}>
            {workspaceStatus}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1 pt-2.5 px-3.5 pb-0">
          <DockTabButton active={femDockTab === "mesh"} label="Mesh" onClick={() => openFemMeshWorkspace("mesh")} />
          <DockTabButton active={femDockTab === "mesher"} label="Mesher" onClick={() => setFemDockTab("mesher")} />
          <DockTabButton active={femDockTab === "view"} label="View" onClick={() => setFemDockTab("view")} />
          <DockTabButton active={femDockTab === "quality"} label="Quality" onClick={() => openFemMeshWorkspace("quality")} />
        </div>

        {ctx.isWaitingForCompute && (
          <div className="mx-3.5 mt-2.5 p-3 rounded-xl bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border border-emerald-500/30 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[0.65rem] font-bold uppercase tracking-widest text-emerald-500">Ready to Compute</div>
                <div className="text-xs text-muted-foreground mt-0.5">Review mesh quality, then start the solver.</div>
              </div>
              <button
                onClick={ctx.handleCompute}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold uppercase tracking-wider shadow-md transition-all hover:shadow-lg active:scale-95"
              >
                ⚡ Compute
              </button>
            </div>
          </div>
        )}

        <div className="min-h-0 overflow-auto pt-3 px-3.5 pb-3.5 grid gap-3 scrollbar-thin scrollbar-thumb-muted-foreground/20">
          {femDockTab === "mesh" && (
            <>
              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Topology</span>
                  <span className="text-[0.65rem] font-mono text-muted-foreground/70">
                    {effectiveFemMesh?.elements.length ? "volume mesh" : "surface preview"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Nodes</span>
                    <span className="font-mono text-sm text-foreground">{effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Elements</span>
                    <span className="font-mono text-sm text-foreground">{effectiveFemMesh?.elements.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Boundary faces</span>
                    <span className="font-mono text-sm text-foreground">{effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"}</span>
                  </div>
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Element type</span>
                    <span className="font-mono text-sm text-foreground">{effectiveFemMesh?.elements.length ? "tet4" : "surface"}</span>
                  </div>
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">FE order</span>
                    <span className="font-mono text-sm text-foreground">{meshFeOrder != null ? String(meshFeOrder) : "—"}</span>
                  </div>
                  <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">hmax</span>
                    <span className="font-mono text-sm text-foreground">{meshHmax != null ? fmtSI(meshHmax, "m") : "—"}</span>
                  </div>
                </div>
              </div>

              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Inspect</span>
                  <span className="text-[0.65rem] font-mono text-muted-foreground/70">
                    {isMeshWorkspaceView ? "mesh viewport active" : "mesh viewport hidden"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(["Mesh", "3D", "2D"] as ViewportMode[]).map((mode) => (
                    <button
                      key={mode}
                      className="appearance-none border border-border/40 bg-card/30 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      data-active={effectiveViewMode === mode}
                      onClick={() => handleViewModeChange(mode)}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1">
                  {([
                    ["surface", "Surface"],
                    ["surface+edges", "Surface+Edges"],
                    ["wireframe", "Wireframe"],
                    ["points", "Points"],
                  ] as [RenderMode, string][]).map(([mode, label]) => (
                    <button
                      key={mode}
                      className="appearance-none border border-border/40 bg-card/30 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      data-active={meshRenderMode === mode}
                      onClick={() => setMeshRenderMode(mode)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  Hover a boundary face to preview quality. Click to inspect it, and use
                  Shift/Ctrl-click to build a multi-selection like a real mesh workspace.
                </div>
              </div>

              {meshFaceDetail && (
                <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Selection</span>
                    <span className="text-[0.65rem] font-mono text-muted-foreground/70">
                      {meshSelection.selectedFaceIndices.length} face{meshSelection.selectedFaceIndices.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="grid gap-1.5">
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Face</span>
                      <span className="font-mono text-xs text-foreground break-all">#{meshFaceDetail.faceIndex}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Nodes</span>
                      <span className="font-mono text-xs text-foreground break-all">{meshFaceDetail.nodeIndices.join(", ")}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Area</span>
                      <span className="font-mono text-xs text-foreground break-all">{fmtExp(meshFaceDetail.area)} m²</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Perimeter</span>
                      <span className="font-mono text-xs text-foreground break-all">{fmtSI(meshFaceDetail.perimeter, "m")}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Aspect Ratio</span>
                      <span className="font-mono text-xs text-foreground break-all">{meshFaceDetail.aspectRatio.toFixed(2)}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Edges</span>
                      <span className="font-mono text-xs text-foreground break-all">{meshFaceDetail.edgeLengths.map((value) => fmtSI(value, "m")).join(" · ")}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Centroid</span>
                      <span className="font-mono text-xs text-foreground break-all">{meshFaceDetail.centroid.map((value) => fmtExp(value)).join(", ")}</span>
                    </div>
                    <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Normal</span>
                      <span className="font-mono text-xs text-foreground break-all">{meshFaceDetail.normal.map((value) => value.toFixed(3)).join(", ")}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      className="appearance-none border border-border/40 bg-card/30 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null })}
                      type="button"
                    >
                      Clear selection
                    </button>
                  </div>
                </div>
              )}

              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Geometry Bounds</span>
                </div>
                <div className="grid gap-1.5">
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mesh name</span>
                    <span className="font-mono text-xs text-foreground break-all">{meshName ?? "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Source</span>
                    <span className="font-mono text-xs text-foreground break-all" title={meshSource ?? undefined}>
                      {meshSource ? meshSource.split("/").pop() : "generated"}
                    </span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Extent X</span>
                    <span className="font-mono text-xs text-foreground break-all">{meshExtent ? fmtSI(meshExtent[0], "m") : "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Extent Y</span>
                    <span className="font-mono text-xs text-foreground break-all">{meshExtent ? fmtSI(meshExtent[1], "m") : "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Extent Z</span>
                    <span className="font-mono text-xs text-foreground break-all">{meshExtent ? fmtSI(meshExtent[2], "m") : "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Bounds min</span>
                    <span className="font-mono text-xs text-foreground break-all">
                      {meshBoundsMin
                        ? `${fmtExp(meshBoundsMin[0])}, ${fmtExp(meshBoundsMin[1])}, ${fmtExp(meshBoundsMin[2])}`
                        : "—"}
                    </span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Bounds max</span>
                    <span className="font-mono text-xs text-foreground break-all">
                      {meshBoundsMax
                        ? `${fmtExp(meshBoundsMax[0])}, ${fmtExp(meshBoundsMax[1])}, ${fmtExp(meshBoundsMax[2])}`
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-lg bg-gradient-to-b from-card/30 to-card/10 border border-border/40">
                <div className="text-[0.65rem] font-bold uppercase tracking-widest text-primary mb-1">Pipeline</div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  {effectiveFemMesh?.elements.length
                    ? "Surface import completed and tetrahedral volume mesh is active."
                    : "Surface preview is shown before full tetrahedral meshing completes."}
                </div>
              </div>
            </>
          )}

          {femDockTab === "mesher" && (
            <>
              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mesher Runtime</span>
                  <span className="text-[0.65rem] font-mono text-muted-foreground/70">{mesherBackend ?? "—"}</span>
                </div>
                <div className="grid gap-1.5">
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Backend</span>
                    <span className="font-mono text-xs text-foreground break-all">{mesherBackend ?? "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Source kind</span>
                    <span className="font-mono text-xs text-foreground break-all">{mesherSourceKind ?? "—"}</span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Order</span>
                    <span className="font-mono text-xs text-foreground break-all">
                      {typeof mesherCurrentSettings?.order === "number" ? String(mesherCurrentSettings.order) : "—"}
                    </span>
                  </div>
                  <div className="grid grid-cols-[92px_1fr] gap-2 items-start">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">hmax</span>
                    <span className="font-mono text-xs text-foreground break-all">
                      {typeof mesherCurrentSettings?.hmax === "number" ? fmtSI(mesherCurrentSettings.hmax, "m") : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <MeshSettingsPanel
                options={meshOptions}
                onChange={setMeshOptions}
                quality={meshQualityData}
                generating={meshGenerating}
                onGenerate={handleMeshGenerate}
                nodeCount={effectiveFemMesh?.nodes.length ?? undefined}
                waitMode={ctx.isWaitingForCompute}
              />
            </>
          )}

          {femDockTab === "view" && (
            <>
              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Field</span>
                </div>
                <label className="grid gap-1.5">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Quantity</span>
                  <select
                    className="appearance-none w-full bg-card/30 border border-border/40 rounded-md text-foreground text-xs py-1.5 px-2 focus:outline-none focus:border-primary"
                    value={requestedPreviewQuantity}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (previewControlsActive) void updatePreview("/quantity", { quantity: next });
                      else setSelectedQuantity(next);
                    }}
                    disabled={previewBusy}
                  >
                    {(previewQuantityOptions.length
                      ? previewQuantityOptions
                      : [{ value: "m", label: "Magnetization", disabled: false }]).map((option) => (
                      <option key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Component</span>
                  {previewControlsActive ? (
                    <select
                      className="appearance-none w-full bg-card/30 border border-border/40 rounded-md text-foreground text-xs py-1.5 px-2 focus:outline-none focus:border-primary"
                      value={requestedPreviewComponent}
                      onChange={(event) =>
                        void updatePreview("/component", { component: event.target.value as PreviewComponent })
                      }
                      disabled={previewBusy}
                    >
                      <option value="3D">3D</option>
                      <option value="x">x</option>
                      <option value="y">y</option>
                      <option value="z">z</option>
                    </select>
                  ) : (
                    <select
                      className="appearance-none w-full bg-card/30 border border-border/40 rounded-md text-foreground text-xs py-1.5 px-2 focus:outline-none focus:border-primary"
                      value={component}
                      onChange={(event) => setComponent(event.target.value as VectorComponent)}
                    >
                      <option value="magnitude">Magnitude</option>
                      <option value="x">x</option>
                      <option value="y">y</option>
                      <option value="z">z</option>
                    </select>
                  )}
                </label>
                {previewControlsActive && (
                  <label className="grid gap-1.5">
                    <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Refresh</span>
                    <select
                      className="appearance-none w-full bg-card/30 border border-border/40 rounded-md text-foreground text-xs py-1.5 px-2 focus:outline-none focus:border-primary"
                      value={requestedPreviewEveryN}
                      onChange={(event) => void updatePreview("/everyN", { everyN: Number(event.target.value) })}
                      disabled={previewBusy}
                    >
                      {previewEveryNOptions.map((value) => (
                        <option key={value} value={value}>
                          {fmtPreviewEveryN(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Rendering</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {([
                    ["surface", "Surface"],
                    ["surface+edges", "Surface+Edges"],
                    ["wireframe", "Wireframe"],
                    ["points", "Points"],
                  ] as [RenderMode, string][]).map(([mode, label]) => (
                    <button
                      key={mode}
                      className="appearance-none border border-border/40 bg-card/30 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      data-active={meshRenderMode === mode}
                      onClick={() => setMeshRenderMode(mode)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="grid gap-1.5">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Opacity</span>
                  <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                    <input
                      className="w-full accent-primary"
                      type="range"
                      min={10}
                      max={100}
                      value={meshOpacity}
                      onChange={(event) => setMeshOpacity(Number(event.target.value))}
                    />
                    <span className="font-mono text-[0.65rem] text-muted-foreground min-w-[44px] text-right">{meshOpacity}%</span>
                  </div>
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground [&>input]:accent-primary">
                  <input
                    type="checkbox"
                    checked={meshShowArrows}
                    onChange={(event) => setMeshShowArrows(event.target.checked)}
                  />
                  <span>Show vector arrows on the surface</span>
                </label>
              </div>

              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Clipping</span>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground [&>input]:accent-primary">
                  <input
                    type="checkbox"
                    checked={meshClipEnabled}
                    onChange={(event) => setMeshClipEnabled(event.target.checked)}
                  />
                  <span>Enable clip plane</span>
                </label>
                <div className="flex flex-wrap gap-1">
                  {(["x", "y", "z"] as ClipAxis[]).map((axis) => (
                    <button
                      key={axis}
                      className="appearance-none border border-border/40 bg-card/30 text-muted-foreground text-[0.65rem] font-bold uppercase tracking-widest rounded-md py-1.5 px-2 cursor-pointer transition-colors hover:bg-muted/50 data-[active=true]:bg-primary/20 data-[active=true]:border-primary/50 data-[active=true]:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      data-active={meshClipAxis === axis}
                      onClick={() => setMeshClipAxis(axis)}
                      type="button"
                      disabled={!meshClipEnabled}
                    >
                      {axis.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                  <input
                    className="w-full accent-primary"
                    type="range"
                    min={0}
                    max={100}
                    value={meshClipPos}
                    onChange={(event) => setMeshClipPos(Number(event.target.value))}
                    disabled={!meshClipEnabled}
                  />
                  <span className="font-mono text-[0.65rem] text-muted-foreground min-w-[44px] text-right">{meshClipPos}%</span>
                </div>
              </div>
            </>
          )}

          {femDockTab === "quality" && (
            <>
              <div className="grid gap-2.5 p-3 rounded-xl bg-gradient-to-b from-card/40 to-card/20 border border-border/40 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Boundary Triangle Quality</span>
                  <span className="text-[0.65rem] font-mono text-muted-foreground/70">
                    {meshQualitySummary
                      ? (meshQualitySummary.mean < 3 ? "good" : meshQualitySummary.mean < 6 ? "fair" : "poor")
                      : "pending"}
                  </span>
                </div>
                {meshQualitySummary ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mean AR</span>
                        <span className="font-mono text-sm text-foreground">{meshQualitySummary.mean.toFixed(2)}</span>
                      </div>
                      <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Min AR</span>
                        <span className="font-mono text-sm text-foreground">{meshQualitySummary.min.toFixed(2)}</span>
                      </div>
                      <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Max AR</span>
                        <span className="font-mono text-sm text-foreground">{meshQualitySummary.max.toFixed(2)}</span>
                      </div>
                      <div className="grid gap-1 px-2.5 py-2 rounded-lg bg-card/30 border border-border/40">
                        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Faces analysed</span>
                        <span className="font-mono text-sm text-foreground">{meshQualitySummary.count.toLocaleString()}</span>
                      </div>
                    </div>
                    {([
                      ["Good", meshQualitySummary.good, "success"],
                      ["Fair", meshQualitySummary.fair, "warn"],
                      ["Poor", meshQualitySummary.poor, "danger"],
                    ] as [string, number, "success" | "warn" | "danger"][]).map(([label, count, tone]) => {
                      const pct = meshQualitySummary.count > 0 ? (count / meshQualitySummary.count) * 100 : 0;
                      return (
                        <div key={label} className="grid grid-cols-[42px_1fr_48px] items-center gap-2">
                          <span className="text-[0.65rem] font-bold text-muted-foreground">{label}</span>
                          <div className="h-2 rounded-full overflow-hidden bg-muted/30">
                            <progress className="w-full h-full appearance-none border-none rounded-full bg-primary [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary data-[tone=success]:[&::-webkit-progress-value]:bg-emerald-500 data-[tone=success]:[&::-moz-progress-bar]:bg-emerald-500 data-[tone=warn]:[&::-webkit-progress-value]:bg-amber-500 data-[tone=warn]:[&::-moz-progress-bar]:bg-amber-500 data-[tone=danger]:[&::-webkit-progress-value]:bg-destructive data-[tone=danger]:[&::-moz-progress-bar]:bg-destructive" value={pct} max={100} data-tone={tone} />
                          </div>
                          <span className="font-mono text-[0.65rem] text-muted-foreground text-right">{pct.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div className="text-xs leading-relaxed text-muted-foreground">
                    Quality statistics will appear once the FEM boundary surface is available.
                  </div>
                )}
              </div>

              <div className="p-3 rounded-lg bg-gradient-to-b from-card/30 to-card/10 border border-border/40">
                <div className="text-[0.65rem] font-bold uppercase tracking-widest text-primary mb-1">Interpretation</div>
                <div className="text-xs leading-relaxed text-muted-foreground">
                  Good meshes cluster near AR≈1-3. If the poor fraction stays high, lower
                  `hmax` or clean the imported surface before tetrahedralization.
                </div>
              </div>
            </>
          )}
        </div>
        </div>
      </Panel>

      <PanelResizeHandle className="h-full w-2 bg-transparent cursor-ew-resize flex items-center justify-center transition-colors relative hover:bg-muted/50 active:bg-muted/50 after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:w-[2px] after:h-9 after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50" />

      <Panel
        id="workspace-fem-viewport"
        defaultSize={PANEL_SIZES.femViewportDefault}
        minSize={PANEL_SIZES.femViewportMin}
      >
        <div className="relative flex flex-col h-full min-h-0 min-w-0 overflow-hidden bg-background flex-1">
          <ViewportBar />
          {previewNotices}
          <ViewportCanvasArea />
        </div>
      </Panel>
    </>
  );
}

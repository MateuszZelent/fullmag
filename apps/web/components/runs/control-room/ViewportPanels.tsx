"use client";

import { cn } from "@/lib/utils";
import MagnetizationSlice2D from "../../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../../preview/MagnetizationView3D";
import FemMeshView3D from "../../preview/FemMeshView3D";
import FemMeshSlice2D from "../../preview/FemMeshSlice2D";
import PreviewScalarField2D from "../../preview/PreviewScalarField2D";
import EmptyState from "../../ui/EmptyState";
import DimensionOverlay from "../../preview/DimensionOverlay";
import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";
import { fmtExp, fmtPreviewMaxPoints, fmtSI } from "./shared";
import { useControlRoom } from "./ControlRoomContext";

export function ViewportBar() {
  const ctx = useControlRoom();

  return (
    <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 bg-card/30 border-b border-border/40 shrink-0">
      {ctx.isMeshWorkspaceView ? (
        <>
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Mesh</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.meshName ?? "boundary surface"}</span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} nodes</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"} faces</span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Render</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.meshRenderMode === "surface+edges" ? "surface+edges" : ctx.meshRenderMode}
          </span>
          {ctx.meshSelection.primaryFaceIndex != null && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Face</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">#{ctx.meshSelection.primaryFaceIndex}</span>
            </>
          )}
        </>
      ) : ctx.isMeshWorkspaceView && !ctx.isFemBackend ? (
        /* FDM geometry bar */
        <>
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Geometry</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.solverGrid[0]}×{ctx.solverGrid[1]}×{ctx.solverGrid[2]}
          </span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Cells</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.totalCells?.toLocaleString() ?? "—"}
          </span>
          {ctx.activeMaskPresent && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Active</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">
                {ctx.activeCells?.toLocaleString() ?? "—"}
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Qty</span>
          <select
            className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
            value={ctx.requestedPreviewQuantity}
            onChange={(e) => {
              const next = e.target.value;
              if (ctx.previewControlsActive) {
                void ctx.updatePreview("/quantity", { quantity: next });
              } else {
                ctx.setSelectedQuantity(next);
              }
            }}
            disabled={ctx.previewBusy}
          >
            {((ctx.previewControlsActive ? ctx.previewQuantityOptions : ctx.quantityOptions).length
              ? (ctx.previewControlsActive ? ctx.previewQuantityOptions : ctx.quantityOptions)
              : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>

          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Comp</span>
          {ctx.previewControlsActive ? (
            <select
              className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
              value={ctx.requestedPreviewComponent}
              onChange={(e) => void ctx.updatePreview("/component", { component: e.target.value })}
              disabled={ctx.previewBusy}
            >
              <option value="3D">3D</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          ) : (
            <select
              className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
              value={ctx.component}
              onChange={(e) => ctx.setComponent(e.target.value as any)}
            >
              <option value="magnitude">|v|</option>
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          )}

          {ctx.previewControlsActive && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Every</span>
              <select
                className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                value={ctx.requestedPreviewEveryN}
                onChange={(e) =>
                  void ctx.updatePreview("/everyN", { everyN: Number(e.target.value) })
                }
                disabled={ctx.previewBusy}
              >
                {ctx.previewEveryNOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Pts</span>
              <select
                className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                value={ctx.requestedPreviewMaxPoints}
                onChange={(e) =>
                  void ctx.updatePreview("/maxPoints", { maxPoints: Number(e.target.value) })
                }
                disabled={ctx.previewBusy}
              >
                {ctx.previewMaxPointOptions.map((value) => (
                  <option key={value} value={value}>
                    {fmtPreviewMaxPoints(value)}
                  </option>
                ))}
              </select>
            </>
          )}

          {ctx.preview ? (
            <>
              {ctx.preview.x_possible_sizes.length > 0 && ctx.preview.y_possible_sizes.length > 0 && (
                <>
                  <span className="w-[1px] h-4 bg-border/40 shrink-0" />
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">X</span>
                  <select
                    className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                    value={ctx.requestedPreviewXChosenSize}
                    onChange={(e) =>
                      void ctx.updatePreview("/XChosenSize", { xChosenSize: Number(e.target.value) })
                    }
                    disabled={ctx.previewBusy}
                  >
                    {ctx.preview.x_possible_sizes.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Y</span>
                  <select
                    className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                    value={ctx.requestedPreviewYChosenSize}
                    onChange={(e) =>
                      void ctx.updatePreview("/YChosenSize", { yChosenSize: Number(e.target.value) })
                    }
                    disabled={ctx.previewBusy}
                  >
                    {ctx.preview.y_possible_sizes.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </>
              )}
              <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground [accent-color:hsl(var(--primary))]">
                <input
                  type="checkbox"
                  checked={ctx.requestedPreviewAutoScale}
                  onChange={(e) =>
                    void ctx.updatePreview("/autoScaleEnabled", {
                      autoScaleEnabled: e.target.checked,
                    })
                  }
                  disabled={ctx.previewBusy}
                />
                <span>Auto-fit</span>
              </label>
              {ctx.preview.spatial_kind === "grid" && ctx.solverGrid[2] > 1 && (
                <>
                  <span className="w-[1px] h-4 bg-border/40 shrink-0" />
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Z-Slice</span>
                  <span className="font-mono text-[0.65rem] tabular-nums text-muted-foreground min-w-[2.5rem] text-center">
                    {ctx.requestedPreviewAllLayers ? "avg" : `${ctx.requestedPreviewLayer}/${ctx.solverGrid[2] - 1}`}
                  </span>
                  <Slider
                    className="w-24 shrink-0"
                    min={0}
                    max={Math.max(ctx.solverGrid[2] - 1, 0)}
                    step={1}
                    value={[ctx.requestedPreviewLayer]}
                    onValueChange={(v) => void ctx.updatePreview("/layer", { layer: v[0] })}
                    disabled={ctx.previewBusy || ctx.requestedPreviewAllLayers}
                  />
                  <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
                    <Switch
                      checked={ctx.requestedPreviewAllLayers}
                      onCheckedChange={(checked) =>
                        void ctx.updatePreview("/allLayers", { allLayers: checked })
                      }
                      disabled={ctx.previewBusy}
                      className="h-4 w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted"
                    />
                    <span>Average</span>
                  </label>
                </>
              )}
              {ctx.preview.spatial_kind === "mesh" && ctx.effectiveViewMode === "2D" && (
                <>
                  <span className="w-[1px] h-4 bg-border/40 shrink-0" />
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Plane</span>
                  <select
                    className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                    value={ctx.plane}
                    onChange={(e) => ctx.setPlane(e.target.value as any)}
                  >
                    <option value="xy">XY</option>
                    <option value="xz">XZ</option>
                    <option value="yz">YZ</option>
                  </select>
                  <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Slice</span>
                  <select
                    className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                    value={ctx.sliceIndex}
                    onChange={(e) => ctx.setSliceIndex(Number(e.target.value))}
                  >
                    {Array.from({ length: ctx.maxSliceCount }, (_, i) => (
                      <option key={i} value={i}>{i + 1}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          ) : ctx.effectiveViewMode === "2D" && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Plane</span>
              <select
                className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                value={ctx.plane}
                onChange={(e) => ctx.setPlane(e.target.value as any)}
              >
                <option value="xy">XY</option>
                <option value="xz">XZ</option>
                <option value="yz">YZ</option>
              </select>
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">Slice</span>
              <select
                className="appearance-none bg-card/30 border border-border/40 rounded text-foreground text-[0.65rem] py-1 px-1.5 cursor-pointer min-w-0 focus:outline-none focus:border-primary"
                value={ctx.sliceIndex}
                onChange={(e) => ctx.setSliceIndex(Number(e.target.value))}
              >
                {Array.from({ length: ctx.maxSliceCount }, (_, i) => (
                  <option key={i} value={i}>{i + 1}</option>
                ))}
              </select>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function ViewportCanvasArea() {
  const ctx = useControlRoom();
  const show3DOverlay = (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh") && !!ctx.worldExtent;

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 min-w-0 relative overflow-hidden [&>*]:min-w-0 [&>*]:min-h-0 [&>*:not(.viewportOverlay)]:flex-1 [&>*:not(.viewportOverlay)]:w-full">
      <div className="viewportOverlay absolute top-2 right-2 flex flex-col gap-1 z-10 pointer-events-none text-right font-mono text-xs text-muted-foreground bg-background/50 backdrop-blur-sm p-1.5 rounded-md border border-border/30 shadow-sm">
        <span>Step {ctx.effectiveStep.toLocaleString()}</span>
        <span>{fmtSI(ctx.effectiveTime, "s")}</span>
        {ctx.effectiveDmDt > 0 && (
          <span className={cn(ctx.effectiveDmDt < 1e-5 && "text-emerald-500")}>
            dm/dt {fmtExp(ctx.effectiveDmDt)}
          </span>
        )}
      </div>
      {show3DOverlay && (
        <DimensionOverlay
          worldExtent={ctx.worldExtent!}
          gridCells={ctx.solverGrid[0] > 0 ? ctx.solverGrid : null}
          visible
        />
      )}
      {!ctx.isVectorQuantity ? (
        <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
          <EmptyState
            title={ctx.quantityDescriptor?.label ?? "Scalar quantity"}
            description={
              ctx.selectedScalarValue !== null
                ? `Latest: ${ctx.selectedScalarValue.toExponential(4)} ${ctx.quantityDescriptor?.unit ?? ""}`
                : "Scalar — see Scalars in sidebar."
            }
            tone="info"
            compact
          />
        </div>
      ) : ctx.preview && ctx.preview.spatial_kind === "grid" && ctx.preview.type === "2D" && ctx.preview.scalar_field.length > 0 ? (
        <PreviewScalarField2D
          data={ctx.preview.scalar_field}
          grid={ctx.preview.preview_grid}
          quantityLabel={ctx.quantityDescriptor?.label ?? ctx.preview.quantity}
          quantityUnit={ctx.preview.unit}
          component={ctx.preview.component}
          min={ctx.preview.min}
          max={ctx.preview.max}
        />
      ) : ctx.effectiveViewMode === "Mesh" && ctx.isFemBackend && ctx.femMeshData ? (
        <FemMeshView3D
          topologyKey={ctx.femTopologyKey ?? undefined}
          meshData={ctx.femMeshData}
          colorField="none"
          toolbarMode="hidden"
          renderMode={ctx.meshRenderMode}
          opacity={ctx.meshOpacity}
          clipEnabled={ctx.meshClipEnabled}
          clipAxis={ctx.meshClipAxis}
          clipPos={ctx.meshClipPos}
          showArrows={false}
          onRenderModeChange={ctx.setMeshRenderMode}
          onOpacityChange={ctx.setMeshOpacity}
          onClipEnabledChange={ctx.setMeshClipEnabled}
          onClipAxisChange={ctx.setMeshClipAxis}
          onClipPosChange={ctx.setMeshClipPos}
          onShowArrowsChange={ctx.setMeshShowArrows}
          onSelectionChange={ctx.setMeshSelection}
        />
      ) : ctx.effectiveViewMode === "Mesh" && !ctx.isFemBackend ? (
        <MagnetizationView3D
          grid={ctx.previewGrid}
          vectors={null}
          fieldLabel="Geometry"
          geometryMode
          activeMask={ctx.activeMask}
          worldExtent={ctx.worldExtent}
        />
      ) : ctx.effectiveViewMode === "3D" && ctx.isFemBackend && ctx.femMeshData ? (
        <FemMeshView3D
          topologyKey={ctx.femTopologyKey ?? undefined}
          meshData={ctx.femMeshData}
          fieldLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
          colorField={ctx.femColorField}
          showOrientationLegend={ctx.femMagnetization3DActive}
          toolbarMode="hidden"
          renderMode={ctx.meshRenderMode}
          opacity={ctx.meshOpacity}
          clipEnabled={ctx.meshClipEnabled}
          clipAxis={ctx.meshClipAxis}
          clipPos={ctx.meshClipPos}
          showArrows={ctx.femShouldShowArrows}
          onRenderModeChange={ctx.setMeshRenderMode}
          onOpacityChange={ctx.setMeshOpacity}
          onClipEnabledChange={ctx.setMeshClipEnabled}
          onClipAxisChange={ctx.setMeshClipAxis}
          onClipPosChange={ctx.setMeshClipPos}
          onShowArrowsChange={ctx.setMeshShowArrows}
          onSelectionChange={ctx.setMeshSelection}
        />
      ) : ctx.effectiveViewMode === "2D" && ctx.isFemBackend && ctx.femMeshData ? (
        <FemMeshSlice2D
          meshData={ctx.femMeshData}
          quantityLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
          quantityId={ctx.selectedQuantity}
          component={ctx.effectiveVectorComponent}
          plane={ctx.plane}
          sliceIndex={ctx.sliceIndex}
          sliceCount={ctx.maxSliceCount}
        />
      ) : ctx.effectiveViewMode === "3D" ? (
        <MagnetizationView3D
          grid={ctx.previewGrid}
          vectors={ctx.selectedVectors}
          fieldLabel={ctx.quantityDescriptor?.label ?? ctx.preview?.quantity ?? ctx.selectedQuantity}
          activeMask={ctx.activeMask}
          worldExtent={ctx.worldExtent}
        />
      ) : ctx.effectiveViewMode === "2D" ? (
        <MagnetizationSlice2D
          grid={ctx.previewGrid}
          vectors={ctx.selectedVectors}
          quantityLabel={ctx.quantityDescriptor?.label ?? ctx.preview?.quantity ?? ctx.selectedQuantity}
          quantityId={ctx.preview?.quantity ?? ctx.selectedQuantity}
          component={ctx.component}
          plane={ctx.plane}
          sliceIndex={ctx.sliceIndex}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
          <EmptyState
            title={ctx.emptyStateMessage.title}
            description={ctx.emptyStateMessage.description}
            tone="info"
          />
        </div>
      )}
    </div>
  );
}

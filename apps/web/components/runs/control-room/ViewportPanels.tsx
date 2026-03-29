"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { cn } from "@/lib/utils";
import MagnetizationSlice2D from "../../preview/MagnetizationSlice2D";
import MagnetizationView3D from "../../preview/MagnetizationView3D";
import FemMeshView3D from "../../preview/FemMeshView3D";
import FemMeshSlice2D from "../../preview/FemMeshSlice2D";
import PreviewScalarField2D from "../../preview/PreviewScalarField2D";
import EmptyState from "../../ui/EmptyState";

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
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Mesh</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.meshName ?? "boundary surface"}</span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} nodes</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">{ctx.effectiveFemMesh?.boundary_faces.length.toLocaleString() ?? "0"} faces</span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Render</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.meshRenderMode === "surface+edges" ? "surface+edges" : ctx.meshRenderMode}
          </span>
          {ctx.meshSelection.primaryFaceIndex != null && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Face</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">#{ctx.meshSelection.primaryFaceIndex}</span>
            </>
          )}
        </>
      ) : ctx.isMeshWorkspaceView && !ctx.isFemBackend ? (
        /* FDM geometry bar */
        <>
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Geometry</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.solverGrid[0]}×{ctx.solverGrid[1]}×{ctx.solverGrid[2]}
          </span>
          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Cells</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {ctx.totalCells?.toLocaleString() ?? "—"}
          </span>
          {ctx.activeMaskPresent && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Active</span>
              <span className="font-mono text-[0.65rem] text-muted-foreground">
                {ctx.activeCells?.toLocaleString() ?? "—"}
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Qty</span>
          <Select
            value={ctx.selectedQuantity}
            onValueChange={(val) => ctx.requestPreviewQuantity(val)}
            disabled={ctx.previewBusy}
          >
            <SelectTrigger className="h-6 min-w-[120px] max-w-[200px] border-border/40 bg-card/30 text-[0.65rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {((ctx.quantityOptions).length
                ? ctx.quantityOptions
                : [{ value: "m", label: "Magnetization", disabled: false }]).map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="w-[1px] h-4 bg-border/40 shrink-0" />
          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Comp</span>
          {ctx.previewControlsActive ? (
            <Select
              value={ctx.requestedPreviewComponent}
              onValueChange={(val) => void ctx.updatePreview("/component", { component: val })}
              disabled={ctx.previewBusy}
            >
              <SelectTrigger className="h-6 w-[60px] border-border/40 bg-card/30 text-[0.65rem] justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3D">3D</SelectItem>
                <SelectItem value="x">x</SelectItem>
                <SelectItem value="y">y</SelectItem>
                <SelectItem value="z">z</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Select
              value={ctx.component}
              onValueChange={(val) => ctx.setComponent(val as any)}
            >
              <SelectTrigger className="h-6 w-[60px] border-border/40 bg-card/30 text-[0.65rem] justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="magnitude">|v|</SelectItem>
                <SelectItem value="x">x</SelectItem>
                <SelectItem value="y">y</SelectItem>
                <SelectItem value="z">z</SelectItem>
              </SelectContent>
            </Select>
          )}

          {ctx.previewControlsActive && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Every</span>
              <Select
                value={String(ctx.requestedPreviewEveryN)}
                onValueChange={(val) => void ctx.updatePreview("/everyN", { everyN: Number(val) })}
                disabled={ctx.previewBusy}
              >
                <SelectTrigger className="h-6 w-[60px] border-border/40 bg-card/30 text-[0.65rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ctx.previewEveryNOptions.map((val) => (
                    <SelectItem key={val} value={String(val)}>{val}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Pts</span>
              <Select
                value={String(ctx.requestedPreviewMaxPoints)}
                onValueChange={(val) => void ctx.updatePreview("/maxPoints", { maxPoints: Number(val) })}
                disabled={ctx.previewBusy}
              >
                <SelectTrigger className="h-6 w-[70px] border-border/40 bg-card/30 text-[0.65rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ctx.previewMaxPointOptions.map((val) => (
                    <SelectItem key={val} value={String(val)}>{fmtPreviewMaxPoints(val)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {ctx.preview ? (
            <>
              {ctx.preview.x_possible_sizes.length > 0 && ctx.preview.y_possible_sizes.length > 0 && (
                <>
                  <span className="w-[1px] h-4 bg-border/40 shrink-0" />
                  <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">X</span>
                  <Select
                    value={String(ctx.requestedPreviewXChosenSize)}
                    onValueChange={(val) => void ctx.updatePreview("/XChosenSize", { xChosenSize: Number(val) })}
                    disabled={ctx.previewBusy}
                  >
                    <SelectTrigger className="h-6 w-[60px] border-border/40 bg-card/30 text-[0.65rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ctx.preview.x_possible_sizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Y</span>
                  <Select
                    value={String(ctx.requestedPreviewYChosenSize)}
                    onValueChange={(val) => void ctx.updatePreview("/YChosenSize", { yChosenSize: Number(val) })}
                    disabled={ctx.previewBusy}
                  >
                    <SelectTrigger className="h-6 w-[60px] border-border/40 bg-card/30 text-[0.65rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ctx.preview.y_possible_sizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Z-Slice</span>
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
                  <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Plane</span>
                  <Select value={ctx.plane} onValueChange={(val) => ctx.setPlane(val as any)}>
                    <SelectTrigger className="h-6 w-16 bg-card/30 border-border/40 text-[0.65rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="xy">XY</SelectItem>
                      <SelectItem value="xz">XZ</SelectItem>
                      <SelectItem value="yz">YZ</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Slice</span>
                  <Select value={String(ctx.sliceIndex)} onValueChange={(val) => ctx.setSliceIndex(Number(val))}>
                    <SelectTrigger className="h-6 min-w-[3.5rem] bg-card/30 border-border/40 text-[0.65rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: ctx.maxSliceCount }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>{i + 1}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </>
          ) : ctx.effectiveViewMode === "2D" && (
            <>
              <span className="w-[1px] h-4 bg-border/40 shrink-0" />
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Plane</span>
              <Select value={ctx.plane} onValueChange={(val) => ctx.setPlane(val as any)}>
                <SelectTrigger className="h-6 w-16 bg-card/30 border-border/40 text-[0.65rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xy">XY</SelectItem>
                  <SelectItem value="xz">XZ</SelectItem>
                  <SelectItem value="yz">YZ</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/40 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">Slice</span>
              <Select value={String(ctx.sliceIndex)} onValueChange={(val) => ctx.setSliceIndex(Number(val))}>
                <SelectTrigger className="h-6 min-w-[3.5rem] bg-card/30 border-border/40 text-[0.65rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: ctx.maxSliceCount }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>{i + 1}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function ViewportCanvasArea() {
  const ctx = useControlRoom();

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

"use client";

import { memo, useCallback, useMemo } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { cn } from "@/lib/utils";

import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";
import {
  fmtExp,
  fmtPreviewMaxPoints,
  fmtSI,
} from "./shared";
import { type SlicePlane, type VectorComponent } from "./shared";
import { useTransport, useViewport, useCommand, useModel } from "./context-hooks";
import { DEFAULT_CONVERGENCE_THRESHOLD } from "../../panels/SolverSettingsPanel";
import {
  domainFrameSourceLabel,
  visibleVolumeLabel,
} from "./viewportUtils";

function ViewportChip({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "active" | "warning" | "success";
}) {
  const toneClass =
    tone === "active"
      ? "border-info/25 bg-info/10 text-info"
      : tone === "warning"
        ? "border-warning/25 bg-warning/10 text-warning"
        : tone === "success"
          ? "border-success/25 bg-success/10 text-success"
          : "border-border/35 bg-background/45 text-foreground/85";
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-md border px-2.5 py-1", toneClass)}>
      <span className="text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-[0.68rem] leading-none">{value}</span>
    </div>
  );
}

export const ViewportBar = memo(function ViewportBar() {
  /* Granular hooks replacing useControlRoom */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const ctx = { ..._transport, ..._viewport, ..._cmd, ..._model };
  if (!FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar) {
    return null;
  }
  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const selectedDisplayIsGlobalScalar =
    ctx.preview?.kind === "global_scalar" || ctx.quantityDescriptor?.kind === "global_scalar";
  const frameLabel = domainFrameSourceLabel(ctx.worldExtentSource);
  const visibleLabel = visibleVolumeLabel(
    ctx.isFemBackend,
    ctx.meshClipEnabled,
    ctx.meshClipAxis,
    ctx.meshClipPos,
  );
  const isVectorComponent = useCallback(
    (value: string): value is VectorComponent =>
      value === "magnitude" || value === "x" || value === "y" || value === "z",
    [],
  );
  const isSlicePlane = useCallback(
    (value: string): value is SlicePlane =>
      value === "xy" || value === "xz" || value === "yz",
    [],
  );
  const toClipAxis = useCallback(
    (plane: SlicePlane): "x" | "y" | "z" => (plane === "xy" ? "z" : plane === "xz" ? "y" : "x"),
    [],
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/20 bg-card/10 px-3 py-2 shrink-0">
      {ctx.isMeshWorkspaceView ? (
        <>
          <ViewportChip label="Mesh" value={ctx.meshName ?? "boundary surface"} />
          <ViewportChip
            label="State"
            value={
              ctx.meshGenerating
                ? "Building"
                : ctx.meshConfigDirty
                  ? "Last Built"
                  : "Up to Date"
            }
            tone={
              ctx.meshGenerating
                ? "active"
                : ctx.meshConfigDirty
                  ? "warning"
                  : "success"
            }
          />
          <ViewportChip
            label="Topology"
            value={`${ctx.effectiveFemMesh?.nodes.length.toLocaleString() ?? "0"} n · ${ctx.effectiveFemMesh?.elements.length.toLocaleString() ?? "0"} tets`}
          />
          <ViewportChip
            label="Render"
            value={ctx.meshRenderMode === "surface+edges" ? "Surface + Edges" : ctx.meshRenderMode}
          />
          <ViewportChip label="Workspace" value={ctx.meshWorkspacePreset.replaceAll("-", " ")} />
          {ctx.isFemBackend && <ViewportChip label="Frame" value={frameLabel} />}
          <ViewportChip
            label="Visible"
            value={visibleLabel}
            tone={ctx.meshClipEnabled ? "warning" : "default"}
          />
          {ctx.meshSelection.primaryFaceIndex != null && (
            <ViewportChip label="Face" value={`#${ctx.meshSelection.primaryFaceIndex}`} />
          )}
          {ctx.meshConfigDirty && !ctx.meshGenerating && (
            <div className="text-[0.72rem] text-warning/90">
              Viewport shows the last built mesh until you rebuild.
            </div>
          )}
        </>
      ) : !ctx.isFemBackend && ctx.isMeshWorkspaceView ? (
        /* FDM geometry bar */
        <>
          <ViewportChip label="Geometry" value={`${ctx.solverGrid[0]}×${ctx.solverGrid[1]}×${ctx.solverGrid[2]}`} />
          <ViewportChip label="Cells" value={ctx.totalCells?.toLocaleString() ?? "—"} />
          {ctx.activeMaskPresent && (
            <ViewportChip label="Active" value={ctx.activeCells?.toLocaleString() ?? "—"} />
          )}
        </>
      ) : (
        <>
          {ctx.isVectorQuantity && (
            <>
              <ViewportChip
                label="Quantity"
                value={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
              />
              {ctx.previewControlsActive ? (
                <Select
                  value={ctx.requestedPreviewComponent}
                  onValueChange={(val) => void ctx.updatePreview("/component", { component: val })}
                  disabled={ctx.previewBusy}
                >
                  <SelectTrigger className="h-8 min-w-[88px] border-border/35 bg-background/45 text-[0.72rem] justify-between">
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
                  onValueChange={(val) => {
                    if (isVectorComponent(val)) {
                      ctx.setComponent(val);
                    }
                  }}
                >
                  <SelectTrigger className="h-8 min-w-[88px] border-border/35 bg-background/45 text-[0.72rem] justify-between">
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
            </>
          )}

          {ctx.previewControlsActive && !selectedDisplayIsGlobalScalar && (
            <>
              <span className="text-[0.68rem] text-muted-foreground">Every</span>
              <Select
                value={String(ctx.requestedPreviewEveryN)}
                onValueChange={(val) => void ctx.updatePreview("/everyN", { everyN: Number(val) })}
                disabled={ctx.previewBusy}
              >
                <SelectTrigger className="h-8 min-w-[84px] border-border/35 bg-background/45 text-[0.72rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ctx.previewEveryNOptions.map((val) => (
                    <SelectItem key={val} value={String(val)}>{val}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[0.68rem] text-muted-foreground">Points</span>
              <Select
                value={String(ctx.requestedPreviewMaxPoints)}
                onValueChange={(val) => void ctx.updatePreview("/maxPoints", { maxPoints: Number(val) })}
                disabled={ctx.previewBusy}
              >
                <SelectTrigger className="h-8 min-w-[94px] border-border/35 bg-background/45 text-[0.72rem]">
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

          {ctx.isFemBackend && (
            <>
              <ViewportChip label="Frame" value={frameLabel} />
              <ViewportChip
                label="Visible"
                value={visibleLabel}
                tone={ctx.meshClipEnabled ? "warning" : "default"}
              />
            </>
          )}

          {spatialPreview ? (
            <>
              {spatialPreview.x_possible_sizes.length > 0 &&
                spatialPreview.y_possible_sizes.length > 0 && (
                <>
                  <span className="text-[0.68rem] text-muted-foreground">X</span>
                  <Select
                    value={String(ctx.requestedPreviewXChosenSize)}
                    onValueChange={(val) => void ctx.updatePreview("/XChosenSize", { xChosenSize: Number(val) })}
                    disabled={ctx.previewBusy}
                  >
                    <SelectTrigger className="h-8 min-w-[72px] border-border/35 bg-background/45 text-[0.72rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {spatialPreview.x_possible_sizes.map((size) => (
                        <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[0.68rem] text-muted-foreground">Y</span>
                  <Select
                    value={String(ctx.requestedPreviewYChosenSize)}
                    onValueChange={(val) => void ctx.updatePreview("/YChosenSize", { yChosenSize: Number(val) })}
                    disabled={ctx.previewBusy}
                  >
                    <SelectTrigger className="h-8 min-w-[72px] border-border/35 bg-background/45 text-[0.72rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {spatialPreview.y_possible_sizes.map((size) => (
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
              {spatialPreview.spatial_kind === "grid" && ctx.solverGrid[2] > 1 && (
                <>
                  <ViewportChip
                    label="Z Slice"
                    value={ctx.requestedPreviewAllLayers ? "Average" : `${ctx.requestedPreviewLayer}/${ctx.solverGrid[2] - 1}`}
                  />
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
              {spatialPreview.spatial_kind === "mesh" && ctx.effectiveViewMode === "2D" && (
                <>
                  <span className="text-[0.68rem] text-muted-foreground">Plane</span>
                  <Select
                    value={ctx.meshClipAxis === "x" ? "yz" : ctx.meshClipAxis === "y" ? "xz" : "xy"}
                    onValueChange={(val) => {
                      if (isSlicePlane(val)) {
                        ctx.setPlane(val);
                        ctx.setMeshClipAxis(toClipAxis(val));
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 min-w-[78px] bg-background/45 border-border/35 text-[0.72rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="xy">XY</SelectItem>
                      <SelectItem value="xz">XZ</SelectItem>
                      <SelectItem value="yz">YZ</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-[0.68rem] text-muted-foreground">Clip</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.1}
                    value={ctx.meshClipPos}
                    onChange={(event) => ctx.setMeshClipPos(Number(event.target.value))}
                    className="h-8 w-28 accent-primary"
                  />
                  <span className="min-w-[3.5rem] text-right text-[0.68rem] text-muted-foreground">
                    {ctx.meshClipPos.toFixed(1)}%
                  </span>
                </>
              )}
            </>
          ) : ctx.effectiveViewMode === "2D" && (
            <>
              <span className="text-[0.68rem] text-muted-foreground">Plane</span>
              <Select
                value={ctx.plane}
                onValueChange={(val) => {
                  if (isSlicePlane(val)) {
                    ctx.setPlane(val);
                  }
                }}
              >
                <SelectTrigger className="h-8 min-w-[78px] bg-background/45 border-border/35 text-[0.72rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xy">XY</SelectItem>
                  <SelectItem value="xz">XZ</SelectItem>
                  <SelectItem value="yz">YZ</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[0.68rem] text-muted-foreground">Slice</span>
              <Select value={String(ctx.sliceIndex)} onValueChange={(val) => ctx.setSliceIndex(Number(val))}>
                <SelectTrigger className="h-8 min-w-[72px] bg-background/45 border-border/35 text-[0.72rem]">
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
});

function formatDt(value: number | null | undefined, enabled: boolean): string {
  if (!enabled || typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return fmtSI(value, "s");
}

function resolveSolverDisplayName(integrator: string | null | undefined): string {
  if (!integrator) {
    return "—";
  }
  const normalized = integrator.trim().toLowerCase();
  const aliases: Record<string, string> = {
    heun: "Heun",
    rk4: "RK4",
    rk23: "RK23",
    rk45: "RK45",
    abm3: "ABM3",
  };
  return aliases[normalized] ?? integrator;
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveMinDt(params: {
  liveRows: { solver_dt: number }[];
  fallbackMin: number | null;
  hasSolverTelemetry: boolean;
}): number | null {
  const candidates = params.liveRows
    .map((row) => row.solver_dt)
    .filter(isPositiveFinite);
  const liveMin = candidates.length > 0 ? Math.min(...candidates) : null;
  if (!params.hasSolverTelemetry) return null;
  return params.fallbackMin ?? liveMin;
}

function resolveMaxDt(params: {
  liveRows: { solver_dt: number }[];
  fallbackMax: number | null;
  hasSolverTelemetry: boolean;
}): number | null {
  const candidates = params.liveRows
    .map((row) => row.solver_dt)
    .filter(isPositiveFinite);
  const liveMax = candidates.length > 0 ? Math.max(...candidates) : null;
  if (!params.hasSolverTelemetry) return null;
  return params.fallbackMax ?? liveMax;
}

export const TelemetryHUD = memo(function TelemetryHUD() {
  const transport = useTransport();
  const model = useModel();
  if (!FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud) {
    return null;
  }
  const toleranceFromSettings = parsePositiveNumber(model.solverSettings.torqueTolerance);
  const convergenceTolerance = toleranceFromSettings ?? Number(DEFAULT_CONVERGENCE_THRESHOLD);

  const liveRangeFromRows = useMemo(
    () => transport.scalarRows.slice(-128),
    [transport.scalarRows],
  );
  const commandAdaptiveDtMin = model.solverPlan?.adaptive?.dtMin;
  const commandAdaptiveDtMax = model.solverPlan?.adaptive?.dtMax;
  const fixedDtFromPlan = model.solverPlan?.fixedTimestep;
  const fixedDtFromSettings = parsePositiveNumber(model.solverSettings.fixedTimestep);
  const currentSolver = resolveSolverDisplayName(
    model.solverPlan?.integrator || model.solverSettings.integrator,
  );
  const fixedDt = typeof fixedDtFromPlan === "number" && Number.isFinite(fixedDtFromPlan) && fixedDtFromPlan > 0
    ? fixedDtFromPlan
    : fixedDtFromSettings;
  const minDt = resolveMinDt({
    liveRows: liveRangeFromRows,
    fallbackMin: isPositiveFinite(commandAdaptiveDtMin) ? commandAdaptiveDtMin : null,
    hasSolverTelemetry: transport.hasSolverTelemetry,
  });
  const maxDt = resolveMaxDt({
    liveRows: liveRangeFromRows,
    fallbackMax: isPositiveFinite(commandAdaptiveDtMax) ? commandAdaptiveDtMax : null,
    hasSolverTelemetry: transport.hasSolverTelemetry,
  });

  return (
    <div className="viewportOverlay absolute top-3 left-1/2 -translate-x-1/2 flex flex-wrap items-center justify-center gap-4 z-10 pointer-events-none text-center font-mono text-[0.7rem] font-bold tracking-wide text-foreground/80 bg-background/60 backdrop-blur-md px-5 py-1.5 rounded-full border border-border/30 shadow-md">
      <span>Step {transport.effectiveStep.toLocaleString()}</span>
      <span>{fmtSI(transport.effectiveTime, "s")}</span>
      <span>solver {currentSolver}</span>
      <span>dt {formatDt(transport.effectiveDt, transport.hasSolverTelemetry)}</span>
      <span>minDt {formatDt(minDt, transport.hasSolverTelemetry)}</span>
      <span>maxDt {formatDt(maxDt, transport.hasSolverTelemetry)}</span>
      <span>fixDt {fixedDt != null && fixedDt > 0 ? fmtSI(fixedDt, "s") : "—"}</span>
      {transport.effectiveDmDt > 0 && (
        <span className={cn(transport.effectiveDmDt < convergenceTolerance ? "text-emerald-400" : "text-amber-400")}>
          dm/dt {fmtExp(transport.effectiveDmDt)}
        </span>
      )}
    </div>
  );
});

"use client";

import {
  Box,
  Grid3X3,
  Grid2X2,
  Grip,
  Palette,
  Scissors,
  Eye,
  ArrowUpRight,
  Video,
  Camera,
  Layers,
} from "lucide-react";
import { ViewportToolbar3D } from "../ViewportToolbar3D";
import { ViewportToolGroup, ViewportToolSeparator } from "../ViewportToolGroup";
import { ViewportIconAction } from "../ViewportIconAction";
import { ViewportPopoverPanel, ViewportPopoverRow, ViewportPopoverTrigger } from "../ViewportPopoverPanel";
import { ViewportStatusChip } from "../ViewportStatusChips";
import type { FemArrowColorMode, FemColorField, RenderMode, ClipAxis } from "../FemMeshView3D";
import type { FemViewportNavigation, FemViewportProjection } from "./FemViewportTypes";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";
import {
  GLYPH_BUDGET_MAX,
  GLYPH_BUDGET_MIN,
  GLYPH_BUDGET_STEP,
} from "./vectorDensityBudget";

export interface FemViewportToolbarProps {
  renderMode: RenderMode;
  surfaceColorField: FemColorField;
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  projection: FemViewportProjection;
  navigation: FemViewportNavigation;
  qualityProfile: ViewportQualityProfileId;
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  clipFlip: boolean;
  arrowsVisible: boolean;
  arrowDensity: number;
  effectiveArrowDensity?: number;
  vectorDomainFilter: "auto" | "magnetic_only" | "full_domain" | "airbox_only";
  supportsAirboxOnlyVectors: boolean;
  ferromagnetVisibilityMode: "hide" | "ghost";
  opacity: number;
  shrinkFactor: number;
  showShrink: boolean;
  labeledMode: boolean;
  legendOpen: boolean;
  partExplorerOpen: boolean;
  visiblePartsCount?: number;
  totalPartsCount?: number;
  hasField?: boolean;
  fieldLabel?: string;
  openPopover: string | null;
  onOpenPopoverChange: (id: string | null) => void;
  onRenderModeChange: (value: RenderMode) => void;
  onSurfaceColorFieldChange: (value: FemColorField) => void;
  onArrowColorModeChange: (value: FemArrowColorMode) => void;
  onArrowMonoColorChange: (value: string) => void;
  onArrowAlphaChange: (value: number) => void;
  onArrowLengthScaleChange: (value: number) => void;
  onArrowThicknessChange: (value: number) => void;
  onProjectionChange: (value: FemViewportProjection) => void;
  onNavigationChange: (value: FemViewportNavigation) => void;
  onQualityProfileChange: (value: ViewportQualityProfileId) => void;
  onClipEnabledChange: (value: boolean) => void;
  onClipAxisChange: (value: ClipAxis) => void;
  onClipPosChange: (value: number) => void;
  onClipFlipChange: (value: boolean) => void;
  onArrowsVisibleChange: (value: boolean) => void;
  onArrowDensityChange: (value: number) => void;
  onVectorDomainFilterChange: (
    value: "auto" | "magnetic_only" | "full_domain" | "airbox_only",
  ) => void;
  onFerromagnetVisibilityModeChange: (value: "hide" | "ghost") => void;
  onOpacityChange: (value: number) => void;
  onShrinkFactorChange: (value: number) => void;
  onLabeledModeChange: (value: boolean) => void;
  onToggleLegend: () => void;
  onTogglePartExplorer: () => void;
  onCameraPreset: (view: "reset" | "front" | "top" | "right") => void;
  onCapture: () => void;
  // quantity selector (optional)
  quantityId?: string;
  quantityOptions?: Array<{ id: string; shortLabel: string; available: boolean }>;
  onQuantityChange?: (id: string) => void;
  compact?: boolean;
  // mixed-state indicators (P3)
  renderModeMixed?: boolean;
  opacityMixed?: boolean;
  colorFieldMixed?: boolean;
  // arrows diagnostic (P4)
  arrowsRequested?: boolean;
  arrowsBlockReason?: string | null;
  // toolbar scope label (P2)
  toolbarScopeLabel?: string | null;
  // runtime degradation active (P5)
  interactionSimplified?: boolean;
}

const RENDER_OPTIONS: { value: RenderMode; icon: React.ReactNode; label: string; title: string }[] = [
  { value: "surface", icon: <Box size={14} />, label: "Surface", title: "Surface" },
  { value: "surface+edges", icon: <Grid3X3 size={14} />, label: "S+E", title: "Surface + Edges" },
  { value: "wireframe", icon: <Grid2X2 size={14} />, label: "Wire", title: "Wireframe" },
  { value: "points", icon: <Grip size={14} />, label: "Pts", title: "Points" },
];

const COLOR_OPTIONS: { value: FemColorField; label: string; fullLabel: string }[] = [
  { value: "orientation", label: "Ori", fullLabel: "Orientation" },
  { value: "z", label: "m_z", fullLabel: "Field Z" },
  { value: "x", label: "m_x", fullLabel: "Field X" },
  { value: "y", label: "m_y", fullLabel: "Field Y" },
  { value: "magnitude", label: "|m|", fullLabel: "|Field|" },
  { value: "quality", label: "Qual", fullLabel: "Quality AR" },
  { value: "sicn", label: "SICN", fullLabel: "SICN" },
  { value: "none", label: "—", fullLabel: "None" },
];

const ARROW_COLOR_OPTIONS: { value: FemArrowColorMode; label: string; fullLabel: string }[] = [
  { value: "orientation", label: "Ori", fullLabel: "Orientation" },
  { value: "z", label: "m_z", fullLabel: "Field Z" },
  { value: "x", label: "m_x", fullLabel: "Field X" },
  { value: "y", label: "m_y", fullLabel: "Field Y" },
  { value: "magnitude", label: "|m|", fullLabel: "|Field|" },
  { value: "monochrome", label: "Mono", fullLabel: "Monochrome" },
];

const QUALITY_PROFILES: { value: ViewportQualityProfileId; label: string }[] = [
  { value: "interactive", label: "Interactive" },
  { value: "balanced", label: "Balanced" },
  { value: "figure", label: "Figure" },
  { value: "capture", label: "Capture" },
];

const POPOVER_OPTION_CLASSNAME =
  "border border-transparent bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40 text-[0.65rem] font-semibold uppercase rounded px-2 py-1 transition-colors data-[active=true]:border-primary/45 data-[active=true]:bg-primary/18 data-[active=true]:text-primary";

export function FemViewportToolbar({
  renderMode,
  surfaceColorField,
  arrowColorMode,
  arrowMonoColor,
  arrowAlpha,
  arrowLengthScale,
  arrowThickness,
  projection,
  navigation,
  qualityProfile,
  clipEnabled,
  clipAxis,
  clipPos,
  clipFlip,
  arrowsVisible,
  arrowDensity,
  effectiveArrowDensity,
  vectorDomainFilter,
  supportsAirboxOnlyVectors,
  ferromagnetVisibilityMode,
  opacity,
  shrinkFactor,
  showShrink,
  labeledMode,
  legendOpen,
  partExplorerOpen,
  visiblePartsCount,
  totalPartsCount,
  hasField,
  fieldLabel,
  openPopover,
  onOpenPopoverChange,
  onRenderModeChange,
  onSurfaceColorFieldChange,
  onArrowColorModeChange,
  onArrowMonoColorChange,
  onArrowAlphaChange,
  onArrowLengthScaleChange,
  onArrowThicknessChange,
  onProjectionChange,
  onNavigationChange,
  onQualityProfileChange,
  onClipEnabledChange,
  onClipAxisChange,
  onClipPosChange,
  onClipFlipChange,
  onArrowsVisibleChange,
  onArrowDensityChange,
  onVectorDomainFilterChange,
  onFerromagnetVisibilityModeChange,
  onOpacityChange,
  onShrinkFactorChange,
  onLabeledModeChange,
  onToggleLegend,
  onTogglePartExplorer,
  onCameraPreset,
  onCapture,
  quantityId,
  quantityOptions = [],
  onQuantityChange,
  compact = false,
  renderModeMixed = false,
  opacityMixed = false,
  colorFieldMixed = false,
  arrowsRequested = false,
  arrowsBlockReason = null,
  toolbarScopeLabel = null,
  interactionSimplified = false,
}: FemViewportToolbarProps) {
  const effectiveDensity = effectiveArrowDensity ?? arrowDensity;
  const availableQuantities = quantityOptions.filter((o) => o.available);
  const activeQuantity = quantityOptions.find((o) => o.id === quantityId) ?? null;

  // Dynamic labels based on active quantity (Fix #7)
  const qSym = activeQuantity?.shortLabel ?? "m";
  const dynamicColorOptions = COLOR_OPTIONS.map((o) => {
    if (o.value === "x") return { ...o, label: `${qSym}_x`, fullLabel: `${qSym} X` };
    if (o.value === "y") return { ...o, label: `${qSym}_y`, fullLabel: `${qSym} Y` };
    if (o.value === "z") return { ...o, label: `${qSym}_z`, fullLabel: `${qSym} Z` };
    if (o.value === "magnitude") return { ...o, label: `|${qSym}|`, fullLabel: `|${qSym}|` };
    return o;
  });
  const dynamicArrowColorOptions = ARROW_COLOR_OPTIONS.map((o) => {
    if (o.value === "x") return { ...o, label: `${qSym}_x`, fullLabel: `${qSym} X` };
    if (o.value === "y") return { ...o, label: `${qSym}_y`, fullLabel: `${qSym} Y` };
    if (o.value === "z") return { ...o, label: `${qSym}_z`, fullLabel: `${qSym} Z` };
    if (o.value === "magnitude") return { ...o, label: `|${qSym}|`, fullLabel: `|${qSym}|` };
    return o;
  });
  const activeSurfaceColorOpt = dynamicColorOptions.find((o) => o.value === surfaceColorField);
  const activeArrowColorOpt =
    dynamicArrowColorOptions.find((o) => o.value === arrowColorMode)
    ?? dynamicArrowColorOptions[0];

  return (
    <ViewportToolbar3D
      compact={compact}
      sideChildren={
        visiblePartsCount !== undefined && totalPartsCount !== undefined ? (
          <div className="flex flex-col items-end gap-1.5">
            <ViewportStatusChip color="default">
              {visiblePartsCount}/{totalPartsCount} parts
            </ViewportStatusChip>
          </div>
        ) : undefined
      }
    >
      {/* ── Quantity selector (when simulation has multiple quantities) ── */}
      {availableQuantities.length > 0 && (
        <>
          <ViewportToolGroup label="Quantity" compact={compact}>
            <ViewportPopoverTrigger preferredHorizontal="left">
              <ViewportIconAction
                icon={<Layers size={14} />}
                label={compact ? undefined : activeQuantity?.shortLabel ?? "Qty"}
                showCaret
                active={openPopover === "quantity"}
                onClick={() => onOpenPopoverChange(openPopover === "quantity" ? null : "quantity")}
                title="Preview Quantity"
              />
              {openPopover === "quantity" && (
                <ViewportPopoverPanel anchorRef={{ current: null }} title="Quantity">
                  <div className="grid grid-cols-2 gap-1 min-w-[220px]">
                    {availableQuantities.map((opt) => (
                      <ViewportIconAction
                        key={opt.id}
                        active={quantityId === opt.id}
                        onClick={() => {
                          onQuantityChange?.(opt.id);
                          onOpenPopoverChange(null);
                        }}
                        label={opt.shortLabel}
                        className="justify-start px-2 py-1.5"
                      />
                    ))}
                  </div>
                </ViewportPopoverPanel>
              )}
            </ViewportPopoverTrigger>
          </ViewportToolGroup>
          {!compact ? <ViewportToolSeparator /> : null}
        </>
      )}

      {/* ── Render mode ── */}
      <ViewportToolGroup label="Render" compact={compact}>
        {RENDER_OPTIONS.map((opt) => (
          <ViewportIconAction
            key={opt.value}
            icon={opt.icon}
            active={renderMode === opt.value}
            onClick={() => onRenderModeChange(opt.value)}
            title={opt.title}
          />
        ))}
      </ViewportToolGroup>

      {!compact ? <ViewportToolSeparator /> : null}

      {/* ── Color field ── */}
      <ViewportToolGroup label="Color" compact={compact}>
          <ViewportPopoverTrigger preferredHorizontal="left">
              <ViewportIconAction
                icon={<Palette size={14} />}
            label={
              labeledMode
                ? `${activeSurfaceColorOpt?.fullLabel ?? "Surface"} / ${activeArrowColorOpt?.fullLabel ?? "Arrows"}`
                : compact
                  ? undefined
                : `${activeSurfaceColorOpt?.label ?? "Surf"} / ${activeArrowColorOpt?.label ?? "Arr"}`
            }
            active={openPopover === "color"}
            showCaret
            onClick={() => onOpenPopoverChange(openPopover === "color" ? null : "color")}
            title="Surface and Arrow Colors"
          />
          {openPopover === "color" && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Color Modes">
              <div className="flex min-w-[260px] flex-col gap-3">
                <ViewportPopoverRow label="Surface">
                  <div className="grid grid-cols-2 gap-1">
                    {dynamicColorOptions.map((opt) => (
                      <ViewportIconAction
                        key={`surface-${opt.value}`}
                        active={surfaceColorField === opt.value}
                        onClick={() => {
                          onSurfaceColorFieldChange(opt.value);
                        }}
                        label={opt.fullLabel}
                        className={`justify-start px-2 py-1.5 ${surfaceColorField === opt.value ? "ring-1 ring-primary/60" : ""}`}
                      />
                    ))}
                  </div>
                </ViewportPopoverRow>
                <ViewportPopoverRow label="Arrows">
                  <div className="grid grid-cols-2 gap-1">
                    {dynamicArrowColorOptions.map((opt) => (
                      <ViewportIconAction
                        key={`arrows-${opt.value}`}
                        active={arrowColorMode === opt.value}
                        onClick={() => {
                          onArrowColorModeChange(opt.value);
                        }}
                        label={opt.fullLabel}
                        className={`justify-start px-2 py-1.5 ${arrowColorMode === opt.value ? "ring-1 ring-primary/60" : ""}`}
                      />
                    ))}
                  </div>
                </ViewportPopoverRow>
                {arrowColorMode === "monochrome" && (
                  <ViewportPopoverRow label="Arrow Color">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={arrowMonoColor}
                        onChange={(e) => onArrowMonoColorChange(e.target.value)}
                        className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
                      />
                      <span className="text-[0.6rem] text-muted-foreground font-mono">
                        {arrowMonoColor}
                      </span>
                    </div>
                  </ViewportPopoverRow>
                )}
              </div>
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>
      </ViewportToolGroup>

      {!compact ? <ViewportToolSeparator /> : null}

      <ViewportToolGroup compact={compact}>
        <ViewportStatusChip color="primary" active>
          Surf {activeSurfaceColorOpt?.label ?? "—"}
        </ViewportStatusChip>
        <ViewportStatusChip color="primary" active>
          Arr {activeArrowColorOpt?.label ?? "—"}
        </ViewportStatusChip>
        <ViewportStatusChip color={effectiveDensity < arrowDensity ? "warning" : "default"} active>
          Vec {arrowDensity}
          {effectiveDensity !== arrowDensity ? `->${effectiveDensity}` : ""}
        </ViewportStatusChip>
        {renderModeMixed && (
          <ViewportStatusChip color="warning" active>
            <span title="Visible parts have different render modes">Mixed mode</span>
          </ViewportStatusChip>
        )}
        {opacityMixed && (
          <ViewportStatusChip color="warning" active>
            <span title="Visible parts have different opacity values">Mixed opacity</span>
          </ViewportStatusChip>
        )}
        {colorFieldMixed && (
          <ViewportStatusChip color="warning" active>
            <span title="Visible parts have different color fields">Mixed color</span>
          </ViewportStatusChip>
        )}
        {toolbarScopeLabel && (
          <ViewportStatusChip color="info" active>
            <span title="Toolbar controls apply to this scope">{toolbarScopeLabel}</span>
          </ViewportStatusChip>
        )}
        {arrowsRequested && !arrowsVisible && arrowsBlockReason && (
          <ViewportStatusChip color="warning" active>
            <span title={arrowsBlockReason}>Vectors blocked</span>
          </ViewportStatusChip>
        )}
        {interactionSimplified && (
          <ViewportStatusChip color="default" active>
            <span title="Render quality reduced during camera interaction">Simplified</span>
          </ViewportStatusChip>
        )}
      </ViewportToolGroup>

      {!compact ? <ViewportToolSeparator /> : null}

      {hasField && (
        <ViewportStatusChip color="info">{fieldLabel ?? "M"}</ViewportStatusChip>
      )}

      {!compact ? <ViewportToolSeparator /> : null}

      {/* ── Tools group ── */}
      <ViewportToolGroup compact={compact}>
        {/* Clip */}
        <ViewportPopoverTrigger preferredHorizontal="left">
          <ViewportIconAction
            icon={<Scissors size={14} />}
            active={clipEnabled}
            showCaret
            onClick={() => {
              const next = !clipEnabled;
              onClipEnabledChange(next);
              onOpenPopoverChange(next ? "clip" : null);
            }}
            title="Clip Plane"
          />
          {openPopover === "clip" && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Clip Plane">
              <ViewportPopoverRow label="Axis">
                <div className="flex gap-1">
                  {(["x", "y", "z"] as ClipAxis[]).map((axis) => (
                    <ViewportIconAction
                      key={axis}
                      active={clipAxis === axis}
                      onClick={() => onClipAxisChange(axis)}
                      label={axis.toUpperCase()}
                      className="px-3"
                    />
                  ))}
                </div>
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Position">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={clipPos}
                  onChange={(event) => onClipPosChange(Number(event.target.value))}
                  className="flex-1 max-w-[180px]"
                />
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Direction">
                <ViewportIconAction
                  active={clipFlip}
                  onClick={() => onClipFlipChange(!clipFlip)}
                  label={clipFlip ? `+${clipAxis.toUpperCase()}` : `−${clipAxis.toUpperCase()}`}
                  title="Flip clip plane direction"
                  className="px-3"
                />
              </ViewportPopoverRow>
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>
        {/* Display options */}
        <ViewportPopoverTrigger preferredHorizontal="left">
          <ViewportIconAction
            icon={<Eye size={14} />}
            showCaret
            active={openPopover === "display"}
            onClick={() => onOpenPopoverChange(openPopover === "display" ? null : "display")}
            title="Display Options"
          />
          {openPopover === "display" && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Display">
              <ViewportPopoverRow label="Opacity">
                <input
                  type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                  min={10}
                  max={100}
                  value={opacity}
                  onChange={(e) => onOpacityChange(Number(e.target.value))}
                />
              </ViewportPopoverRow>
              {showShrink && (
                <ViewportPopoverRow label="Shrink">
                  <input
                    type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                    min={10}
                    max={100}
                    value={Math.round(shrinkFactor * 100)}
                    onChange={(e) => onShrinkFactorChange(Number(e.target.value) / 100)}
                  />
                </ViewportPopoverRow>
              )}
              <ViewportPopoverRow label="Labels">
                <button
                  className="text-[0.65rem] font-semibold text-muted-foreground hover:text-foreground bg-transparent border border-border/30 rounded px-2 py-0.5"
                  onClick={() => onLabeledModeChange(!labeledMode)}
                >
                  {labeledMode ? "Hide Labels" : "Show Labels"}
                </button>
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Profile">
                <div className="flex flex-wrap gap-1">
                  {QUALITY_PROFILES.map((p) => (
                    <button
                      key={p.value}
                      className={POPOVER_OPTION_CLASSNAME}
                      data-active={qualityProfile === p.value}
                      onClick={() => onQualityProfileChange(p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </ViewportPopoverRow>
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>

        {/* Arrows / Glyphs */}
        <ViewportPopoverTrigger preferredHorizontal="left">
          <ViewportIconAction
            icon={<ArrowUpRight size={14} />}
            active={arrowsVisible}
            showCaret
            onClick={() => {
              const next = !arrowsVisible;
              onArrowsVisibleChange(next);
              onOpenPopoverChange(next ? "vectors" : null);
            }}
            title="Vectors"
          />
          {openPopover === "vectors" && arrowsVisible && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Vectors">
              <ViewportPopoverRow label="Density">
                <input
                  type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                  min={GLYPH_BUDGET_MIN}
                  max={GLYPH_BUDGET_MAX}
                  step={GLYPH_BUDGET_STEP}
                  value={arrowDensity}
                  onChange={(e) => onArrowDensityChange(Number(e.target.value))}
                />
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Domain">
                <div className="flex flex-wrap gap-1">
                  <button
                    className={POPOVER_OPTION_CLASSNAME}
                    data-active={vectorDomainFilter === "auto"}
                    onClick={() => onVectorDomainFilterChange("auto")}
                  >
                    Auto
                  </button>
                  <button
                    className={POPOVER_OPTION_CLASSNAME}
                    data-active={vectorDomainFilter === "magnetic_only"}
                    onClick={() => onVectorDomainFilterChange("magnetic_only")}
                  >
                    Magnetic
                  </button>
                  <button
                    className={POPOVER_OPTION_CLASSNAME}
                    data-active={vectorDomainFilter === "full_domain"}
                    onClick={() => onVectorDomainFilterChange("full_domain")}
                  >
                    Full
                  </button>
                  <button
                    className={POPOVER_OPTION_CLASSNAME}
                    data-active={vectorDomainFilter === "airbox_only"}
                    onClick={() => onVectorDomainFilterChange("airbox_only")}
                    disabled={!supportsAirboxOnlyVectors}
                    title={
                      supportsAirboxOnlyVectors
                        ? "Render vectors only in airbox nodes"
                        : "Unavailable for magnetic-only quantities"
                    }
                  >
                    Airbox
                  </button>
                </div>
              </ViewportPopoverRow>
              {vectorDomainFilter === "airbox_only" ? (
                <ViewportPopoverRow label="Ferro">
                  <div className="flex gap-1">
                    <button
                      className={POPOVER_OPTION_CLASSNAME}
                      data-active={ferromagnetVisibilityMode === "hide"}
                      onClick={() => onFerromagnetVisibilityModeChange("hide")}
                    >
                      Hide
                    </button>
                    <button
                      className={POPOVER_OPTION_CLASSNAME}
                      data-active={ferromagnetVisibilityMode === "ghost"}
                      onClick={() => onFerromagnetVisibilityModeChange("ghost")}
                    >
                      Ghost
                    </button>
                  </div>
                </ViewportPopoverRow>
              ) : null}
              {arrowColorMode === "monochrome" ? (
                <ViewportPopoverRow label="Color">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={arrowMonoColor}
                      onChange={(event) => onArrowMonoColorChange(event.target.value)}
                      className="h-6 w-8 cursor-pointer rounded border border-border/40 bg-transparent p-0"
                      aria-label="Arrow monochrome color"
                    />
                    <span className="font-mono text-[0.62rem] text-muted-foreground">{arrowMonoColor}</span>
                  </div>
                </ViewportPopoverRow>
              ) : null}
              <ViewportPopoverRow label="Alpha">
                <input
                  type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={arrowAlpha}
                  onChange={(e) => onArrowAlphaChange(Number(e.target.value))}
                />
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Length">
                <input
                  type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                  min={0.35}
                  max={2.8}
                  step={0.05}
                  value={arrowLengthScale}
                  onChange={(e) => onArrowLengthScaleChange(Number(e.target.value))}
                />
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Width">
                <input
                  type="range"
                  className="flex-1 h-[3px] accent-primary max-w-[120px]"
                  min={0.35}
                  max={2.8}
                  step={0.05}
                  value={arrowThickness}
                  onChange={(e) => onArrowThicknessChange(Number(e.target.value))}
                />
              </ViewportPopoverRow>
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>

        {/* Camera */}
        <ViewportPopoverTrigger preferredHorizontal="left">
          <ViewportIconAction
            icon={<Video size={14} />}
            showCaret
            active={openPopover === "camera"}
            onClick={() => onOpenPopoverChange(openPopover === "camera" ? null : "camera")}
            title="Camera"
          />
          {openPopover === "camera" && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Camera / View">
              <ViewportPopoverRow label="Proj">
                <button
                  className={POPOVER_OPTION_CLASSNAME}
                  data-active={projection === "perspective"}
                  onClick={() => onProjectionChange("perspective")}
                >
                  Persp
                </button>
                <button
                  className={POPOVER_OPTION_CLASSNAME}
                  data-active={projection === "orthographic"}
                  onClick={() => onProjectionChange("orthographic")}
                >
                  Ortho
                </button>
              </ViewportPopoverRow>
              <ViewportPopoverRow label="Nav">
                <button
                  className={POPOVER_OPTION_CLASSNAME}
                  data-active={navigation === "trackball"}
                  onClick={() => onNavigationChange("trackball")}
                >
                  Trackball
                </button>
                <button
                  className={POPOVER_OPTION_CLASSNAME}
                  data-active={navigation === "cad"}
                  onClick={() => onNavigationChange("cad")}
                >
                  CAD
                </button>
              </ViewportPopoverRow>
              <div className="h-px bg-border/20 my-1" />
              <div className="grid grid-cols-2 gap-1 px-1">
                {(["reset", "front", "top", "right"] as const).map((view) => (
                  <button
                    key={view}
                    className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left"
                    onClick={() => {
                      onCameraPreset(view);
                      onOpenPopoverChange(null);
                    }}
                  >
                    {view === "reset" ? "Reset" : view}
                  </button>
                ))}
              </div>
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>

        {/* Panels */}
        <ViewportPopoverTrigger preferredHorizontal="left">
          <ViewportIconAction
            icon={<Layers size={14} />}
            showCaret
            active={openPopover === "panels"}
            onClick={() => onOpenPopoverChange(openPopover === "panels" ? null : "panels")}
            title="Panels"
          />
          {openPopover === "panels" && (
            <ViewportPopoverPanel anchorRef={{ current: null }} title="Panels">
              <ViewportIconAction
                label="Legend"
                active={legendOpen}
                onClick={onToggleLegend}
                className="justify-start w-full py-1.5"
              />
              <ViewportIconAction
                label={partExplorerOpen ? "Hide Parts" : "Show Parts"}
                active={partExplorerOpen}
                onClick={() => {
                  onTogglePartExplorer();
                  onOpenPopoverChange(null);
                }}
                className="justify-start w-full py-1.5"
              />
            </ViewportPopoverPanel>
          )}
        </ViewportPopoverTrigger>

        {!compact ? <ViewportToolSeparator /> : null}

        {/* Screenshot */}
        <ViewportIconAction
          icon={<Camera size={14} />}
          onClick={onCapture}
          title="Screenshot"
        />
      </ViewportToolGroup>
    </ViewportToolbar3D>
  );
}

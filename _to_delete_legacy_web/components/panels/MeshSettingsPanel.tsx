"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { Loader2, ArrowRightLeft } from "lucide-react";
import { metersTextToNanometersInput, nanometersInputToMetersText } from "@/lib/units";
import { InspectorSection, InspectorField, InspectorStatTile } from "./settings/primitives";

// Types and defaults now live in the model layer. Re-exported here for backward compatibility.
export type { SizeFieldSpec, MeshOptionsState, MeshQualityData } from "@/lib/mesh/options";
export { DEFAULT_MESH_OPTIONS } from "@/lib/mesh/options";
import type { MeshOptionsState, MeshQualityData } from "@/lib/mesh/options";

interface MeshPanelCapabilities {
  supports_adaptive_remesh?: boolean;
  supports_size_field_remesh?: boolean;
}

interface MeshSettingsPanelProps {
  options: MeshOptionsState;
  onChange: (next: MeshOptionsState) => void;
  quality?: MeshQualityData | null;
  disabled?: boolean;
  /** Disables only the generate/build button, independently of `disabled`. */
  generateDisabled?: boolean;
  generating?: boolean;
  onGenerate?: () => void;
  generateLabel?: string;
  generatingLabel?: string;
  nodeCount?: number;
  waitMode?: boolean;
  showAdaptiveSection?: boolean;
  capabilities?: MeshPanelCapabilities | null;
  focus?: "all" | "size" | "transition" | "method" | "optimization";
}

/* ── Algorithm options ─────────────────────────────────────────────── */

const ALGO_2D_OPTIONS = [
  { value: "1", label: "MeshAdapt" },
  { value: "2", label: "Automatic" },
  { value: "5", label: "Delaunay" },
  { value: "6", label: "Frontal-Delaunay" },
  { value: "7", label: "BAMG" },
  { value: "8", label: "Frontal (Quads)" },
];

const ALGO_3D_OPTIONS = [
  { value: "1", label: "Delaunay" },
  { value: "4", label: "Frontal" },
  { value: "7", label: "MMG3D" },
  { value: "10", label: "HXT" },
];

const OPTIMIZE_OPTIONS = [
  { value: "none",            label: "None" },
  { value: "Netgen",      label: "Netgen" },
  { value: "HighOrder",   label: "High Order" },
  { value: "Laplace2D",   label: "Laplace 2D" },
  { value: "Relocate2D",  label: "Relocate 2D" },
  { value: "Relocate3D",  label: "Relocate 3D" },
];

const CALIBRATE_FOR_OPTIONS = [
  { value: "general_physics", label: "General physics" },
  { value: "micromagnetics_static", label: "Micromagnetics (static)" },
  { value: "micromagnetics_relaxation", label: "Micromagnetics (relaxation)" },
  { value: "micromagnetics_frequency_domain", label: "Micromagnetics (frequency domain)" },
  { value: "magnetostatics_dominated", label: "Magnetostatics dominated" },
  { value: "imported_surface_cleanup", label: "Imported surface cleanup" },
];

const SIZE_PRESET_OPTIONS = [
  { value: "extremely_fine", label: "Extremely fine" },
  { value: "extra_fine", label: "Extra fine" },
  { value: "finer", label: "Finer" },
  { value: "fine", label: "Fine" },
  { value: "normal", label: "Normal" },
  { value: "coarse", label: "Coarse" },
  { value: "coarser", label: "Coarser" },
  { value: "extra_coarse", label: "Extra coarse" },
  { value: "extremely_coarse", label: "Extremely coarse" },
];

const ADAPTIVE_INDICATOR_OPTIONS = [
  { value: "geometric_only", label: "Geometric only" },
  { value: "micromagnetics_hybrid", label: "Micromagnetics hybrid" },
  { value: "magnetostatic_potential", label: "Magnetostatic potential" },
];

const ADAPTIVE_TARGET_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "h_demag_gradient", label: "H_demag gradient" },
  { value: "phi_jump", label: "Potential jump residual" },
  { value: "exchange_length", label: "Exchange-length limiter" },
  { value: "mode_amplitude", label: "Mode amplitude (eigen)" },
];

const ADAPTIVE_CONVERGENCE_OPTIONS = [
  { value: "energy_delta", label: "Energy delta" },
  { value: "max_torque_delta", label: "Max torque delta" },
  { value: "solution_change", label: "Solution change" },
  { value: "eigenfrequency_delta", label: "Eigenfrequency delta" },
];

const SIZE_MODE_OPTIONS = [
  { value: "predefined", label: "Predefined" },
  { value: "custom", label: "Custom" },
];

/* ── SICN color ────────────────────────────────────────────────────── */

function sicnColor(value: number): string {
  // Maps [-1, 1] → red → yellow → green
  const t = Math.max(0, Math.min(1, (value + 1) / 2));
  if (t < 0.5) {
    const f = t * 2;
    const r = Math.round(207 + (253 - 207) * f);
    const g = Math.round(98 + (231 - 98) * f);
    const b = Math.round(86 + (37 - 86) * f);
    return `rgb(${r},${g},${b})`;
  }
  const f = (t - 0.5) * 2;
  const r = Math.round(253 + (53 - 253) * f);
  const g = Math.round(231 + (183 - 231) * f);
  const b = Math.round(37 + (121 - 37) * f);
  return `rgb(${r},${g},${b})`;
}

function gammaColor(value: number): string {
  // Maps [0, 1] → red → yellow → green
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.5) {
    const f = t * 2;
    return `rgb(${Math.round(207 + 46 * f)},${Math.round(98 + 133 * f)},${Math.round(86 - 49 * f)})`;
  }
  const f = (t - 0.5) * 2;
  return `rgb(${Math.round(253 - 200 * f)},${Math.round(231 - 48 * f)},${Math.round(37 + 84 * f)})`;
}

/* ── Histogram renderer ────────────────────────────────────────────── */

function drawHistogram(
  canvas: HTMLCanvasElement,
  bins: number[],
  rangeMin: number,
  rangeMax: number,
  colorFn: (v: number) => string,
  xLabel: string,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const nBins = bins.length;
  const maxBin = Math.max(...bins, 1);

  const pad = { top: 6, right: 8, bottom: 22, left: 32 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const barW = Math.max(2, plotW / nBins - 1);

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = "hsla(220, 15%, 28%, 0.3)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 3; i++) {
    const y = pad.top + plotH * (1 - i / 3);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // Bars
  const binWidth = (rangeMax - rangeMin) / nBins;
  for (let i = 0; i < nBins; i++) {
    const v = bins[i];
    if (v === 0) continue;
    const barH = (v / maxBin) * plotH;
    const x = pad.left + i * (plotW / nBins) + 0.5;
    const y = pad.top + plotH - barH;
    const value = rangeMin + (i + 0.5) * binWidth;
    ctx.fillStyle = colorFn(value);
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]);
    ctx.fill();
  }

  // Y-axis
  ctx.fillStyle = "hsla(220, 20%, 60%, 0.6)";
  ctx.font = "9px var(--font-mono, monospace)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 3; i++) {
    const val = Math.round((maxBin / 3) * i);
    const y = pad.top + plotH * (1 - i / 3);
    ctx.fillText(String(val), pad.left - 4, y);
  }

  // X-axis
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const step = Math.max(1, Math.floor(nBins / 5));
  for (let i = 0; i < nBins; i += step) {
    const val = (rangeMin + (i + 0.5) * binWidth).toFixed(1);
    const x = pad.left + (i + 0.5) * (plotW / nBins);
    ctx.fillText(val, x, pad.top + plotH + 4);
  }

  // Label
  ctx.fillStyle = "hsla(220, 20%, 55%, 0.5)";
  ctx.font = "8px var(--font-mono, monospace)";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, pad.left + plotW / 2, h - 2);
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function MeshSettingsPanel({
  options,
  onChange,
  quality,
  disabled = false,
  generateDisabled,
  generating = false,
  onGenerate,
  generateLabel = "Build Mesh",
  generatingLabel = "Building Mesh...",
  nodeCount,
  showAdaptiveSection = true,
  capabilities,
  focus = "all",
}: MeshSettingsPanelProps) {
  const sicnCanvasRef = useRef<HTMLCanvasElement>(null);
  const gammaCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const set = useCallback(
    (patch: Partial<MeshOptionsState>) => onChange({ ...options, ...patch }),
    [options, onChange],
  );
  const sizeControlMode = options.sizeControlMode || "predefined";
  const isCustomSizeMode = sizeControlMode === "custom";
  const showAllSections = focus === "all";
  const showMethodSection = focus === "all" || focus === "method";
  const supportsAdaptiveRemesh = capabilities?.supports_adaptive_remesh !== false;
  const supportsSizeFieldRemesh = capabilities?.supports_size_field_remesh !== false;
  const showSizeSection = focus === "all" || focus === "size";
  const showTransitionSection = focus === "all" || focus === "transition";
  const showOptimizationSection = focus === "all" || focus === "optimization";
  const advancedControlsVisible = showAdvanced || !showAllSections;
  const adaptiveIndicatorValue =
    options.adaptiveIndicator === "micromagnetics_hybrid" ||
    options.adaptiveIndicator === "magnetostatic_potential"
      ? options.adaptiveIndicator
      : "geometric_only";

  useEffect(() => {
    if (
      options.adaptiveIndicator !== "geometric_only" &&
      options.adaptiveIndicator !== "micromagnetics_hybrid" &&
      options.adaptiveIndicator !== "magnetostatic_potential"
    ) {
      set({ adaptiveIndicator: "geometric_only" });
    }
  }, [options.adaptiveIndicator, set]);

  // Rating based on SICN p5
  const qualityRating = useMemo(() => {
    if (!quality) return null;
    if (quality.sicnP5 >= 0.5) return { label: "Excellent", cls: "good" };
    if (quality.sicnP5 >= 0.3) return { label: "Good", cls: "good" };
    if (quality.sicnP5 >= 0.1) return { label: "Fair", cls: "fair" };
    return { label: "Poor", cls: "poor" };
  }, [quality]);

  // Draw SICN histogram
  useEffect(() => {
    if (!sicnCanvasRef.current || !quality?.sicnHistogram) return;
    drawHistogram(
      sicnCanvasRef.current,
      quality.sicnHistogram,
      -1, 1,
      sicnColor,
      "SICN (Signed Inverse Condition Number)",
    );
  }, [quality?.sicnHistogram]);

  // Draw gamma histogram
  useEffect(() => {
    if (!gammaCanvasRef.current || !quality?.gammaHistogram) return;
    drawHistogram(
      gammaCanvasRef.current,
      quality.gammaHistogram,
      0, 1,
      gammaColor,
      "γ (inscribed/circumscribed ratio)",
    );
  }, [quality?.gammaHistogram]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* ── Basic / Advanced Toggle ── */}
      {showAllSections ? (
      <div className="flex items-center justify-between gap-3 px-1 border-b border-border/15 pb-3 mb-2">
        <div>
          <div className="text-[0.62rem] font-bold tracking-[0.12em] uppercase text-muted-foreground/80 mb-0.5">
            Mesh settings
          </div>
          <div className="text-[0.72rem] text-muted-foreground">
            Adjust inputs first, then rebuild to update the realized mesh.
          </div>
        </div>
        <button
          type="button"
          className="rounded-md border border-border/20 px-2.5 py-1.5 text-[0.68rem] font-semibold text-muted-foreground transition-all hover:bg-muted/40 hover:text-foreground"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Basic view" : "Advanced view"}
        </button>
      </div>
      ) : null}

      {/* ── Algorithm Selection ── */}
      {showMethodSection && advancedControlsVisible && (
        <InspectorSection
          title="Mesher"
          eyebrow="Advanced"
          meta={<span className="rounded-md bg-muted/40 px-2 py-1 text-[0.62rem] font-mono text-muted-foreground">Gmsh</span>}
        >
          <InspectorField
            label="Surface algorithm"
            hint="Controls STL/classified surface triangulation."
            control={(
              <Select
                value={String(options.algorithm2d)}
                onValueChange={(val) => set({ algorithm2d: Number(val) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALGO_2D_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <InspectorField
            label="Volume algorithm"
            hint="Controls tetrahedral filling of the final shared domain."
            control={(
              <Select
                value={String(options.algorithm3d)}
                onValueChange={(val) => set({ algorithm3d: Number(val) })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALGO_3D_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </InspectorSection>
      )}

      {/* ── Size Control ── */}
      {showSizeSection ? (
      <InspectorSection
        title="Element size"
        eyebrow="Basic"
        meta={<span className="text-[0.62rem] font-mono text-muted-foreground">UI in nm</span>}
      >
        <InspectorField
          label="Size mode"
          hint="Use preset-driven defaults or manual custom values."
          control={(
            <Select
              value={sizeControlMode}
              onValueChange={(val) => set({ sizeControlMode: val as "predefined" | "custom" })}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_MODE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <InspectorField
          label="Calibrate for"
          hint="Calibration profile for preset defaults."
          control={(
            <Select
              value={options.calibrateFor || "general_physics"}
              onValueChange={(val) => set({ calibrateFor: val })}
              disabled={disabled || isCustomSizeMode}
            >
              <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALIBRATE_FOR_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <InspectorField
          label="Predefined"
          hint="Preset ladder from extremely fine to extremely coarse."
          control={(
            <Select
              value={options.sizePreset || "normal"}
              onValueChange={(val) => set({ sizePreset: val })}
              disabled={disabled || isCustomSizeMode}
            >
              <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZE_PRESET_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/8 px-3 py-2 text-[0.68rem] leading-5 text-sky-100/90">
          These values are entered in nanometres. Fullmag converts them to SI metres for the backend, so typing `1` means `1 nm`, not `1 m`.
        </div>
        <InspectorField
          label="Maximum element size (nm)"
          hint="Upper bound for the local target size."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={metersTextToNanometersInput(options.maximumElementSize || options.hmax)}
              onChange={(e) => {
                const meters = nanometersInputToMetersText(e.target.value);
                set({ maximumElementSize: meters, hmax: meters });
              }}
              disabled={disabled || !isCustomSizeMode}
            />
          )}
        />
        <InspectorField
          label="Minimum element size (nm)"
          hint="Lower bound used when local refinement gets very fine."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={metersTextToNanometersInput(options.minimumElementSize || options.hmin)}
              onChange={(e) => {
                const meters = nanometersInputToMetersText(e.target.value);
                set({ minimumElementSize: meters, hmin: meters });
              }}
              disabled={disabled || !isCustomSizeMode}
            />
          )}
        />
        <InspectorField
          label="Curvature factor"
          hint="Refines curved regions when geometry detail requires it."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={options.curvatureFactor || ""}
              onChange={(e) => set({ curvatureFactor: e.target.value })}
              disabled={disabled || !isCustomSizeMode}
            />
          )}
        />
        <InspectorField
          label="Maximum growth rate"
          hint="Limits how quickly elements can grow away from refined zones."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="1.8"
              value={options.maximumElementGrowthRate || options.growthRate}
              onChange={(e) => set({ maximumElementGrowthRate: e.target.value, growthRate: e.target.value })}
              disabled={disabled || !isCustomSizeMode}
            />
          )}
        />
        <InspectorField
          label="Narrow region resolution"
          hint="Minimum target density in tight gaps and channels."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={options.narrowRegionResolution || ""}
              onChange={(e) => set({ narrowRegionResolution: e.target.value })}
              disabled={disabled || !isCustomSizeMode}
            />
          )}
        />
        {!isCustomSizeMode && (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-[0.68rem] leading-5 text-emerald-100/90">
            Preset mode is active. Values below are resolved diagnostics from the translator.
            <div className="mt-1 font-mono">
              resolved_size_from_curvature={options.resolvedSizeFromCurvature ?? 0},{" "}
              resolved_narrow_regions={options.resolvedNarrowRegions ?? 0},{" "}
              resolved_growth_rate={options.resolvedGrowthRate || "auto"}
            </div>
          </div>
        )}
        {advancedControlsVisible ? (
          <InspectorField
            label="Global size factor"
            hint="Applies a global multiplier on top of local sizing rules."
            control={(
              <Input
                className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                type="number"
                step="0.1"
                min="0.1"
                max="10"
                value={options.sizeFactor}
                onChange={(e) => set({ sizeFactor: Number(e.target.value) || 1 })}
                disabled={disabled}
              />
            )}
          />
        ) : null}
      </InspectorSection>
      ) : null}

      {/* ── Interface & Transition (COMSOL-like region controls) ── */}
      {showTransitionSection && advancedControlsVisible && (
      <InspectorSection
        title="Interface & Transition"
        eyebrow="Advanced"
        meta={<span className="text-[0.62rem] font-mono text-muted-foreground">UI in nm</span>}
      >
        <InspectorField
          label="Interface max element size (nm)"
          hint="Target element size near the magnetic–air interface shell."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={metersTextToNanometersInput(options.interfaceHMax)}
              onChange={(e) => set({ interfaceHMax: nanometersInputToMetersText(e.target.value) })}
              disabled={disabled}
            />
          )}
        />
        <InspectorField
          label="Interface thickness (nm)"
          hint="Width of the refinement shell around the interface."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={metersTextToNanometersInput(options.interfaceThickness)}
              onChange={(e) => set({ interfaceThickness: nanometersInputToMetersText(e.target.value) })}
              disabled={disabled}
            />
          )}
        />
        <InspectorField
          label="Transition distance (nm)"
          hint="Distance over which element size grades from object bulk to airbox."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="auto"
              value={metersTextToNanometersInput(options.transitionDistance)}
              onChange={(e) => set({ transitionDistance: nanometersInputToMetersText(e.target.value) })}
              disabled={disabled}
            />
          )}
        />
        <InspectorField
          label="Transition growth rate"
          hint="Growth rate within the transition zone (1.0–3.0)."
          control={(
            <Input
              className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
              type="text"
              placeholder="1.5"
              value={options.transitionGrowth}
              onChange={(e) => set({ transitionGrowth: e.target.value })}
              disabled={disabled}
            />
          )}
        />
      </InspectorSection>
      )}

      {/* ── Optimization ── */}
      {showOptimizationSection && advancedControlsVisible && (
        <InspectorSection title="Optimization" eyebrow="Advanced">
          <InspectorField
            label="Method"
            hint="Optional quality pass after tetrahedral generation."
            control={(
              <Select
                value={options.optimize || "none"}
                onValueChange={(val) => set({ optimize: val === "none" ? "" : val })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPTIMIZE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {options.optimize !== "" ? (
            <InspectorField
              label="Iterations"
              hint="Number of passes for the selected optimizer."
              control={(
                <Input
                  className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                  type="number"
                  step="1"
                  min="1"
                  max="20"
                  value={options.optimizeIters}
                  onChange={(e) => set({ optimizeIters: Number(e.target.value) || 1 })}
                  disabled={disabled}
                />
              )}
            />
          ) : null}
          {options.optimize === "" && options.optimizeIters > 1 ? (
            <div className="rounded-xl border border-warning/25 bg-warning/10 px-3 py-2 text-[0.68rem] leading-5 text-warning/90">
              Optimizer iterations are configured but no optimizer method is selected. The backend will ignore the iteration count until a method such as Netgen or Relocate3D is enabled.
            </div>
          ) : null}
          <InspectorField
            label="Smoothing steps"
            hint="Post-process smoothing for noisy tetrahedra."
            control={(
              <Input
                className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                type="number"
                step="1"
                min="0"
                max="100"
                value={options.smoothingSteps}
                onChange={(e) => set({ smoothingSteps: Number(e.target.value) || 0 })}
                disabled={disabled}
              />
            )}
          />
        </InspectorSection>
      )}

      {/* ── Quality ── */}
      <InspectorSection
        title="Quality analysis"
        eyebrow="Diagnostics"
        meta={qualityRating ? (
          <span className={cn("rounded-md px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-white shadow-sm", qualityRating.cls === "good" ? "bg-emerald-600/80" : qualityRating.cls === "fair" ? "bg-amber-600/80" : "bg-destructive/80")}>
            {qualityRating.label}
          </span>
        ) : undefined}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-foreground">Extract quality metrics</span>
            <Switch
              className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted/80 h-[18px] w-8"
              checked={options.computeQuality}
              onCheckedChange={(checked) => set({ computeQuality: checked })}
              disabled={disabled}
            />
          </div>
          {options.computeQuality && (
            <div className="flex items-center justify-between py-1">
              <span className="text-xs font-medium text-foreground">Per-element data</span>
              <Switch
                className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted/80 h-[18px] w-8"
                checked={options.perElementQuality}
                onCheckedChange={(checked) => set({ perElementQuality: checked })}
                disabled={disabled}
              />
            </div>
          )}

          {quality && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <InspectorStatTile label="Elements" value={quality.nElements.toLocaleString()} />
                <InspectorStatTile label="SICN min" value={quality.sicnMin.toFixed(3)} />
                <InspectorStatTile label="SICN mean" value={quality.sicnMean.toFixed(3)} />
                <InspectorStatTile label="SICN p5" value={quality.sicnP5.toFixed(3)} />
                <InspectorStatTile label="γ min" value={quality.gammaMin.toFixed(3)} />
                <InspectorStatTile label="γ mean" value={quality.gammaMean.toFixed(3)} />
                <InspectorStatTile label="Average ICN" value={quality.avgQuality.toFixed(3)} />
                <InspectorStatTile
                  label="Volume σ/μ"
                  value={quality.volumeMean > 0 ? (quality.volumeStd / quality.volumeMean).toFixed(2) : "—"}
                />
              </div>

              {/* SICN Histogram */}
              <canvas ref={sicnCanvasRef} className="w-full h-16 mt-3 bg-card/20 rounded-md border border-border/15" />
              <div className="flex items-center justify-center gap-3 mt-1.5 text-[0.6rem] text-muted-foreground">
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-destructive" />SICN &lt; 0 (inverted)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-amber-500" />0–0.5 (fair)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-emerald-500" />&gt; 0.5 (good)</span>
              </div>

              {/* Gamma Histogram */}
              <canvas ref={gammaCanvasRef} className="w-full h-16 mt-3 bg-card/20 rounded-md border border-border/15" />
              <div className="flex items-center justify-center gap-3 mt-1.5 text-[0.6rem] text-muted-foreground">
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-destructive" />γ &lt; 0.3 (poor)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-amber-500" />0.3–0.6 (fair)</span>
                <span><span className="inline-block w-1.5 h-1.5 rounded-full mr-1 bg-emerald-500" />&gt; 0.6 (good)</span>
              </div>
            </>
          )}
        </div>
      </InspectorSection>
      {/* ── Solver Compatibility ── */}
      {nodeCount != null && nodeCount > 0 && (
        <InspectorSection title="Solver compatibility" eyebrow="Diagnostics">
          <div className="grid grid-cols-2 gap-2">
            <InspectorStatTile label="Nodes" value={nodeCount.toLocaleString()} />
            <InspectorStatTile
              label="Estimated RAM"
              value={(
                <span
                  className={cn(
                    nodeCount > 50000 ? "text-destructive font-semibold" :
                    nodeCount > 10000 ? "text-amber-400" : "text-emerald-400",
                  )}
                >
                  {((nodeCount * nodeCount * 24) / 1e9).toFixed(1)} GB
                </span>
              )}
            />
          </div>
          {nodeCount > 10000 && (
            <div className={cn("rounded-xl p-2 text-xs",
              nodeCount > 50000
                ? "bg-destructive/10 border border-destructive/30 text-destructive"
                : "bg-amber-500/10 border border-amber-500/30 text-amber-500")}>
              {nodeCount > 50000
                ? "Mesh too large for CPU dense solver. Increase maximum element size to reduce node count."
                : "Large mesh — may be slow. Target <10,000 nodes for CPU reference solver."}
            </div>
          )}
        </InspectorSection>
      )}
      {/* ── Adaptive Mesh (AFEM) ── */}
      {showAdvanced && showAdaptiveSection && (
      <InspectorSection
        title="Adaptive mesh"
        eyebrow="Advanced"
        meta={(
          <Switch
            className="data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted/80 h-[18px] w-8"
            checked={supportsAdaptiveRemesh && options.adaptiveEnabled}
            onCheckedChange={(checked) => set({ adaptiveEnabled: checked && supportsAdaptiveRemesh })}
            disabled={disabled || !supportsAdaptiveRemesh}
          />
        )}
      >
        {!supportsAdaptiveRemesh ? (
          <div className="rounded-xl border border-border/15 bg-card/40 px-3 py-2 text-[0.68rem] leading-5 text-muted-foreground">
            Adaptive remesh is disabled by backend capabilities for this session.
          </div>
        ) : null}
        {options.adaptiveEnabled && (
          <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
            <InspectorField
              label="Policy"
              hint="Use manual remeshes or let adaptive refinement run in the solve loop."
              control={(
                <Select
                  value={options.adaptivePolicy}
                  onValueChange={(val) => set({ adaptivePolicy: val })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual (remesh now)</SelectItem>
                    <SelectItem value="auto">Auto (solve loop)</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <InspectorField
              label="Indicator"
              hint="Select the adaptive refinement indicator model."
              control={(
                <Select
                  value={adaptiveIndicatorValue}
                  onValueChange={(val) => set({ adaptiveIndicator: val })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ADAPTIVE_INDICATOR_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[0.68rem] leading-5 text-amber-100/90">
              Current runtime support for auto follow-up covers <span className="font-mono">geometric_only</span>, <span className="font-mono">micromagnetics_hybrid</span>, and <span className="font-mono">magnetostatic_potential</span>.
            </div>
            <InspectorField
              label="Target quantity"
              hint="Primary physics quantity used to derive target element size."
              control={(
                <Select
                  value={options.adaptiveTargetQuantity || "auto"}
                  onValueChange={(val) => set({ adaptiveTargetQuantity: val })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ADAPTIVE_TARGET_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <InspectorField
              label="Convergence criterion"
              hint="Metric used to stop adaptive passes when stabilized."
              control={(
                <Select
                  value={options.adaptiveConvergenceMetric || "energy_delta"}
                  onValueChange={(val) => set({ adaptiveConvergenceMetric: val })}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-8 w-full border-border/35 bg-background/70 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ADAPTIVE_CONVERGENCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="ml-1 text-[0.65rem] font-medium text-muted-foreground">Theta (θ)</span>
                <Input
                  className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                  type="number" step="0.05" min="0.01" max="1"
                  value={options.adaptiveTheta}
                  onChange={(e) => set({ adaptiveTheta: Number(e.target.value) || 0.3 })}
                  disabled={disabled}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground ml-1">Max Passes</span>
                <Input
                  className="h-7 w-full border-border/50 bg-card px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50 focus-visible:ring-1"
                  type="number" step="1" min="1" max="20"
                  value={options.adaptiveMaxPasses}
                  onChange={(e) => set({ adaptiveMaxPasses: Number(e.target.value) || 2 })}
                  disabled={disabled}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <span className="ml-1 text-[0.65rem] font-medium text-muted-foreground">Min. edge (nm)</span>
                <Input
                  className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                  placeholder="e.g. 5"
                  value={metersTextToNanometersInput(options.adaptiveHMin)}
                  onChange={(e) => set({ adaptiveHMin: nanometersInputToMetersText(e.target.value) })}
                  disabled={disabled}
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="ml-1 text-[0.65rem] font-medium text-muted-foreground">Max. edge (nm)</span>
                <Input
                  className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                  placeholder="e.g. 30"
                  value={metersTextToNanometersInput(options.adaptiveHMax)}
                  onChange={(e) => set({ adaptiveHMax: nanometersInputToMetersText(e.target.value) })}
                  disabled={disabled}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1 mt-1">
              <span className="ml-1 text-[0.65rem] font-medium text-muted-foreground">Error tolerance</span>
              <Input
                className="h-8 w-full border-border/35 bg-background/70 px-2 py-1 text-xs font-mono text-right placeholder:text-muted-foreground/30 disabled:opacity-50"
                placeholder="e.g. 1e-3"
                value={options.adaptiveErrorTolerance}
                onChange={(e) => set({ adaptiveErrorTolerance: e.target.value })}
                disabled={disabled}
              />
            </div>
          </div>
        )}
      </InspectorSection>
      )}

      {/* ── Refinement Zones (lasso) ── */}
      {showAdvanced && options.refinementZones.length > 0 && supportsSizeFieldRemesh && (
        <InspectorSection
          title="Refinement zones"
          eyebrow="Advanced"
          meta={(
            <button
              className="rounded-md px-2 py-1 text-[0.65rem] font-semibold text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={() => set({ refinementZones: [] })}
              disabled={disabled}
            >
              Clear all
            </button>
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              Refinement Zones
              <span className="ml-1.5 text-[0.68rem] font-mono text-muted-foreground">({options.refinementZones.length})</span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {options.refinementZones.map((zone, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-xl border border-border/18 bg-background/25 px-3 py-2">
                <span className="text-[0.68rem] font-mono text-muted-foreground">
                  {zone.kind} #{i + 1} — VIn={typeof zone.params.VIn === "number" ? zone.params.VIn.toExponential(1) : "?"}
                </span>
                <button
                  className="text-[0.65rem] text-destructive/60 hover:text-destructive"
                  onClick={() => set({ refinementZones: options.refinementZones.filter((_, j) => j !== i) })}
                  disabled={disabled}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </InspectorSection>
      )}
      {showAdvanced && options.refinementZones.length > 0 && !supportsSizeFieldRemesh && (
        <InspectorSection title="Refinement zones" eyebrow="Advanced">
          <div className="rounded-xl border border-border/15 bg-card/40 px-3 py-2 text-[0.68rem] leading-5 text-muted-foreground">
            Manual refinement zones are hidden because backend capabilities do not expose size-field remesh for this session.
          </div>
        </InspectorSection>
      )}

      {/* ── Generate button (secondary — primary build is from ribbon) ── */}
      {onGenerate && (
        <InspectorSection title="Quick build" eyebrow="Action">
          <div className="text-[0.62rem] leading-4 text-muted-foreground/60 mb-1">
            Use the ribbon &quot;Build Selected&quot; / &quot;Build All&quot; for targeted builds. This button always rebuilds the full study domain.
          </div>
          <Button
            className="h-8 w-full text-xs font-medium transition-all duration-300"
            variant="outline"
            onClick={onGenerate}
            disabled={(generateDisabled ?? disabled) || generating}
          >
            {generating ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary-foreground/70" />
                {generatingLabel}
              </span>
            ) : (
              generateLabel
            )}
          </Button>

          {generating && (
            <div className="flex flex-col gap-2 pt-1 animate-in fade-in slide-in-from-top-2 duration-300">
              <div className="flex items-center justify-between px-1">
                <span className="flex items-center gap-1.5 text-[0.65rem] font-semibold text-emerald-400">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                  </span>
                  Remesh request sent
                </span>
                <span className="flex items-center gap-1.5 text-[0.65rem] font-semibold text-amber-400">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping delay-150 absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                  </span>
                  Waiting for backend
                </span>
              </div>
              
              <div className="relative h-1.5 w-full bg-muted/40 rounded-full overflow-hidden">
                <div className="absolute inset-y-0 w-1/3 bg-primary rounded-full animate-pulse opacity-80" />
                <div className="absolute inset-y-0 w-2/3 right-0 bg-primary/30 rounded-full animate-pulse" style={{ animationDelay: "150ms" }} />
              </div>
              
              <div className="flex items-center justify-between px-1 mt-0.5 opacity-60">
                <span className="text-[0.62rem] font-mono text-muted-foreground">Backend computing</span>
                <span className="flex items-center gap-1 text-[0.62rem] font-mono tabular-nums text-muted-foreground">
                  <ArrowRightLeft className="w-2.5 h-2.5" /> active
                </span>
              </div>
            </div>
          )}
        </InspectorSection>
      )}
    </div>
  );
}

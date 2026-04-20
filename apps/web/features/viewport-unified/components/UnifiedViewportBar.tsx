/**
 * Unified viewport toolbar.
 *
 * Replaces separate FDM/FEM viewport bars with a single component
 * that shows common controls (component, sampling, color scale) for
 * every discretization and capability-gates FDM-only (layer) and
 * FEM-only (wireframe, clip) controls.
 */

"use client";

import { memo, useCallback } from "react";
import type { CapabilityMap } from "../../../src/api/types";
import type { UnifiedRenderState } from "../model/unifiedViewportTypes";
import { CapabilityPanel } from "./CapabilityPanel";

// ── Helpers ──────────────────────────────────────────────────

const VECTOR_COMPONENTS = ["3D", "x", "y", "z", "|v|"] as const;
const COLOR_SCALES = ["viridis", "coolwarm", "jet", "magma", "inferno"] as const;
const EVERY_N_OPTIONS = [1, 2, 3, 4, 5, 8, 10, 16, 20] as const;
const MESH_RENDER_MODES = ["solid", "wireframe", "points"] as const;

function chipClass(active = false): string {
  return active
    ? "inline-flex items-center rounded-md border border-info/25 bg-info/10 px-2 py-0.5 text-[0.68rem] text-info"
    : "inline-flex items-center rounded-md border border-border/35 bg-background/45 px-2 py-0.5 text-[0.68rem] text-foreground/85";
}

// ── Props ────────────────────────────────────────────────────

interface UnifiedViewportBarProps {
  capabilities: CapabilityMap | null;
  renderState: UnifiedRenderState;
  onRenderStateChange: (next: UnifiedRenderState) => void;
  /** Grid Z-depth for layer slider (FDM). */
  gridDepth?: number;
  disabled?: boolean;
}

// ── Component ────────────────────────────────────────────────

export const UnifiedViewportBar = memo(function UnifiedViewportBar({
  capabilities,
  renderState,
  onRenderStateChange,
  gridDepth,
  disabled = false,
}: UnifiedViewportBarProps) {
  const patch = useCallback(
    (delta: Partial<UnifiedRenderState>) =>
      onRenderStateChange({ ...renderState, ...delta }),
    [renderState, onRenderStateChange],
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/20 bg-card/10 px-3 py-2 shrink-0">
      {/* ── Component selector (always visible) ────────────── */}
      <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
        Component
      </label>
      <select
        className="h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
        value={renderState.vectorComponent}
        onChange={(e) =>
          patch({
            vectorComponent: e.target.value as UnifiedRenderState["vectorComponent"],
          })
        }
        disabled={disabled}
      >
        {VECTOR_COMPONENTS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      {/* ── Sampling / every-N (always visible) ────────────── */}
      <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
        Every
      </label>
      <select
        className="h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
        value={renderState.everyN}
        onChange={(e) => patch({ everyN: Number(e.target.value) })}
        disabled={disabled}
      >
        {EVERY_N_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      {/* ── Color scale (always visible) ───────────────────── */}
      <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
        Colormap
      </label>
      <select
        className="h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
        value={renderState.colorScale}
        onChange={(e) => patch({ colorScale: e.target.value })}
        disabled={disabled}
      >
        {COLOR_SCALES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {/* ── Auto-scale toggle (always visible) ─────────────── */}
      <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={renderState.autoScale}
          onChange={(e) => patch({ autoScale: e.target.checked })}
          disabled={disabled}
        />
        <span>Auto-scale</span>
      </label>

      {/* ── Layer selector (FDM — structured_grid) ─────────── */}
      <CapabilityPanel capabilities={capabilities} requires="structured_grid">
        <span className={chipClass()}>
          Layer {renderState.selectedLayer}
          {gridDepth != null ? ` / ${gridDepth - 1}` : ""}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max((gridDepth ?? 1) - 1, 0)}
          step={1}
          value={renderState.selectedLayer}
          onChange={(e) => patch({ selectedLayer: Number(e.target.value) })}
          className="w-24 accent-primary"
          disabled={disabled || renderState.allLayersVisible}
        />
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={renderState.allLayersVisible}
            onChange={(e) => patch({ allLayersVisible: e.target.checked })}
            disabled={disabled}
          />
          <span>All layers</span>
        </label>
      </CapabilityPanel>

      {/* ── Grid info chip (FDM — structured_grid) ─────────── */}
      <CapabilityPanel capabilities={capabilities} requires="structured_grid">
        {gridDepth != null && (
          <span className={chipClass()}>Z depth: {gridDepth}</span>
        )}
      </CapabilityPanel>

      {/* ── Wireframe mode (FEM — explicit_topology) ───────── */}
      <CapabilityPanel capabilities={capabilities} requires="explicit_topology">
        <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Render
        </label>
        <select
          className="h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
          value={renderState.meshRenderMode ?? "solid"}
          onChange={(e) =>
            patch({
              meshRenderMode: e.target.value as UnifiedRenderState["meshRenderMode"],
            })
          }
          disabled={disabled}
        >
          {MESH_RENDER_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        {/* Mesh opacity */}
        <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Opacity
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={renderState.meshOpacity ?? 100}
          onChange={(e) => patch({ meshOpacity: Number(e.target.value) })}
          className="w-20 accent-primary"
          disabled={disabled}
        />
      </CapabilityPanel>

      {/* ── Clip controls (FEM — explicit_topology) ────────── */}
      <CapabilityPanel capabilities={capabilities} requires="explicit_topology">
        <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={renderState.clipEnabled ?? false}
            onChange={(e) => patch({ clipEnabled: e.target.checked })}
            disabled={disabled}
          />
          <span>Clip</span>
        </label>
        {renderState.clipEnabled && (
          <>
            <select
              className="h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]"
              value={renderState.clipAxis ?? "z"}
              onChange={(e) =>
                patch({
                  clipAxis: e.target.value as "x" | "y" | "z",
                })
              }
              disabled={disabled}
            >
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={renderState.clipPosition ?? 50}
              onChange={(e) => patch({ clipPosition: Number(e.target.value) })}
              className="w-28 accent-primary"
              disabled={disabled}
            />
            <span className="min-w-[3.5rem] text-right text-[0.68rem] text-muted-foreground">
              {(renderState.clipPosition ?? 50).toFixed(1)}%
            </span>
          </>
        )}
      </CapabilityPanel>
    </div>
  );
});

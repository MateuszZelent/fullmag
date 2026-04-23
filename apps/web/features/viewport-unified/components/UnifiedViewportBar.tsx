/**
 * Unified viewport global display bar (Row A).
 *
 * The bar is always rendered with a stable control order for FEM/FDM.
 * Unsupported controls remain visible but disabled with capability hints.
 */

"use client";

import { memo, useCallback } from "react";
import type { CapabilityMap } from "../../../src/api/types";
import type { UnifiedRenderState, FemViewportLayerState } from "../model/unifiedViewportTypes";
import { DEFAULT_FEM_VIEWPORT_LAYER_STATE } from "../model/unifiedViewportTypes";
import type { Viewport3DCapabilities as UnifiedCapabilityReasons } from "../model/viewport3dContracts";

const VECTOR_COMPONENTS = ["3D", "x", "y", "z", "|v|"] as const;
const COLOR_SCALES = ["viridis", "coolwarm", "jet", "magma", "inferno"] as const;
const EVERY_N_OPTIONS = [1, 2, 3, 4, 5, 8, 10, 16, 20] as const;
const MESH_RENDER_MODES: Array<{
  value: NonNullable<UnifiedRenderState["meshRenderMode"]>;
  label: string;
}> = [
  { value: "solid", label: "shaded" },
  { value: "wireframe", label: "wireframe" },
  { value: "solid+wireframe", label: "shaded+wireframe" },
  { value: "points", label: "points" },
];

interface QuantityOption {
  id: string;
  label: string;
  available: boolean;
}

interface UnifiedViewportBarProps {
  capabilities: CapabilityMap | UnifiedCapabilityReasons | null;
  renderState: UnifiedRenderState;
  onRenderStateChange: (next: UnifiedRenderState) => void;
  /** Grid Z-depth for layer slider (FDM). */
  gridDepth?: number;
  disabled?: boolean;
  quantityId?: string;
  quantityOptions?: QuantityOption[];
  onQuantityChange?: (quantityId: string) => void;
  clipFlip?: boolean;
  onClipFlipChange?: (next: boolean) => void;
}

function labelClass() {
  return "text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground";
}

function controlClass() {
  return "h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]";
}

function disabledReason(
  controlsDisabled: boolean,
  capabilityAvailable: boolean,
  reason: string | undefined,
): string | undefined {
  if (controlsDisabled) {
    return "Preview update in progress";
  }
  if (capabilityAvailable) {
    return undefined;
  }
  return reason ?? "Capability unavailable";
}

function isReasonedCapabilityMap(
  value: CapabilityMap | UnifiedCapabilityReasons | null,
): value is UnifiedCapabilityReasons {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "preview3d" in value && "explicitTopology" in value && "structuredGrid" in value;
}

export const UnifiedViewportBar = memo(function UnifiedViewportBar({
  capabilities,
  renderState,
  onRenderStateChange,
  gridDepth,
  disabled = false,
  quantityId,
  quantityOptions = [],
  onQuantityChange,
  clipFlip = false,
  onClipFlipChange,
}: UnifiedViewportBarProps) {
  const patch = useCallback(
    (delta: Partial<UnifiedRenderState>) =>
      onRenderStateChange({ ...renderState, ...delta }),
    [renderState, onRenderStateChange],
  );

  const supports3D = isReasonedCapabilityMap(capabilities)
    ? capabilities.preview3d.enabled
    : Boolean(capabilities?.preview_3d);
  const supportsStructuredGrid = isReasonedCapabilityMap(capabilities)
    ? capabilities.structuredGrid.enabled
    : Boolean(capabilities?.structured_grid);
  const supportsTopology = isReasonedCapabilityMap(capabilities)
    ? capabilities.explicitTopology.enabled
    : Boolean(capabilities?.explicit_topology);
  const preview3dReason = isReasonedCapabilityMap(capabilities)
    ? capabilities.preview3d.reason
    : "Requires preview_3d capability";
  const structuredGridReason = isReasonedCapabilityMap(capabilities)
    ? capabilities.structuredGrid.reason
    : "Requires structured_grid capability";
  const explicitTopologyReason = isReasonedCapabilityMap(capabilities)
    ? capabilities.explicitTopology.reason
    : "Requires explicit_topology capability";

  const threeDReason = disabledReason(disabled, supports3D, preview3dReason);
  const gridReason = disabledReason(
    disabled,
    supportsStructuredGrid,
    structuredGridReason,
  );
  const topologyReason = disabledReason(
    disabled,
    supportsTopology,
    explicitTopologyReason,
  );
  const baseReason = disabled ? "Preview update in progress" : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/20 bg-card/10 px-3 py-2 shrink-0">
      <span className={labelClass()}>Quantity</span>
      <select
        className={controlClass()}
        value={quantityId ?? ""}
        onChange={(event) => onQuantityChange?.(event.target.value)}
        disabled={disabled || !supports3D || !onQuantityChange || quantityOptions.length === 0}
        title={threeDReason}
      >
        {quantityOptions.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.available}>
            {option.label}
          </option>
        ))}
      </select>

      <span className={labelClass()}>Component</span>
      <select
        className={controlClass()}
        value={renderState.vectorComponent}
        onChange={(event) =>
          patch({
            vectorComponent: event.target.value as UnifiedRenderState["vectorComponent"],
          })
        }
        disabled={disabled || !supports3D}
        title={threeDReason}
      >
        {VECTOR_COMPONENTS.map((component) => (
          <option key={component} value={component}>
            {component}
          </option>
        ))}
      </select>

      <span className={labelClass()}>Every N</span>
      <select
        className={controlClass()}
        value={renderState.everyN}
        onChange={(event) => patch({ everyN: Number(event.target.value) })}
        disabled={disabled || !supports3D}
        title={threeDReason}
      >
        {EVERY_N_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>

      <span className={labelClass()}>Colormap</span>
      <select
        className={controlClass()}
        value={renderState.colorScale}
        onChange={(event) => patch({ colorScale: event.target.value })}
        disabled={disabled || !supports3D}
        title={threeDReason}
      >
        {COLOR_SCALES.map((scale) => (
          <option key={scale} value={scale}>
            {scale}
          </option>
        ))}
      </select>

      <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={renderState.autoScale}
          onChange={(event) => patch({ autoScale: event.target.checked })}
          disabled={disabled || !supports3D}
          title={threeDReason}
        />
        <span>Auto-scale</span>
      </label>

      <span className={labelClass()}>Layers</span>
      {(
        [
          { key: "showPrimitives", label: "Primitives" },
          { key: "showMesh", label: "Mesh" },
          { key: "showQuantity", label: "Quantity" },
        ] as const
      ).map(({ key, label }) => {
        const layers: FemViewportLayerState = renderState.femLayers ?? DEFAULT_FEM_VIEWPORT_LAYER_STATE;
        return (
          <label
            key={key}
            className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none"
          >
            <input
              type="checkbox"
              checked={layers[key]}
              onChange={(event) =>
                patch({
                  femLayers: { ...layers, [key]: event.target.checked },
                })
              }
              disabled={disabled || !supportsTopology}
              title={topologyReason}
            />
            <span>{label}</span>
          </label>
        );
      })}

      <span className={labelClass()}>Render</span>
      <select
        className={controlClass()}
        value={renderState.meshRenderMode ?? "solid"}
        onChange={(event) =>
          patch({
            meshRenderMode: event.target.value as UnifiedRenderState["meshRenderMode"],
          })
        }
        disabled={disabled || !supportsTopology}
        title={topologyReason}
      >
        {MESH_RENDER_MODES.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>

      <span className={labelClass()}>Opacity</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={renderState.meshOpacity ?? 100}
        onChange={(event) => patch({ meshOpacity: Number(event.target.value) })}
        className="w-20 accent-primary"
        disabled={disabled || !supportsTopology}
        title={topologyReason}
      />

      <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={renderState.clipEnabled ?? false}
          onChange={(event) => patch({ clipEnabled: event.target.checked })}
          disabled={disabled || !supportsTopology}
          title={topologyReason}
        />
        <span>Clip</span>
      </label>

      <select
        className={controlClass()}
        value={renderState.clipAxis ?? "z"}
        onChange={(event) =>
          patch({
            clipAxis: event.target.value as "x" | "y" | "z",
          })
        }
        disabled={disabled || !supportsTopology || !renderState.clipEnabled}
        title={topologyReason}
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
        onChange={(event) => patch({ clipPosition: Number(event.target.value) })}
        className="w-24 accent-primary"
        disabled={disabled || !supportsTopology || !renderState.clipEnabled}
        title={topologyReason}
      />

      <button
        type="button"
        className="h-7 rounded border border-border/35 bg-background/45 px-2 text-[0.68rem] text-foreground disabled:opacity-50"
        onClick={() => onClipFlipChange?.(!clipFlip)}
        disabled={disabled || !supportsTopology || !renderState.clipEnabled || !onClipFlipChange}
        title={
          onClipFlipChange
            ? topologyReason
            : (baseReason ?? "Clip flip is not exposed by current runtime API")
        }
      >
        {clipFlip ? "-axis" : "+axis"}
      </button>

      <span className="text-[0.68rem] text-muted-foreground">
        Layer {renderState.selectedLayer}
        {gridDepth != null ? ` / ${Math.max(gridDepth - 1, 0)}` : ""}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max((gridDepth ?? 1) - 1, 0)}
        step={1}
        value={renderState.selectedLayer}
        onChange={(event) => patch({ selectedLayer: Number(event.target.value) })}
        className="w-20 accent-primary"
        disabled={disabled || !supportsStructuredGrid || renderState.allLayersVisible}
        title={gridReason}
      />
      <label className="inline-flex items-center gap-1.5 text-[0.65rem] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={renderState.allLayersVisible}
          onChange={(event) => patch({ allLayersVisible: event.target.checked })}
          disabled={disabled || !supportsStructuredGrid}
          title={gridReason}
        />
        <span>All layers</span>
      </label>
    </div>
  );
});

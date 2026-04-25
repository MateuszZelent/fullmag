/**
 * Unified viewport global display bar (Row A).
 *
 * The bar is always rendered with a stable control order for FEM/FDM.
 * Unsupported controls remain visible but disabled with capability hints.
 */

"use client";

import { memo, useCallback } from "react";
import type { CapabilityMap } from "@/src/api/types";
import type { UnifiedRenderState, FemViewportLayerState } from "../model/unifiedViewportTypes";
import { DEFAULT_FEM_VIEWPORT_LAYER_STATE } from "../model/unifiedViewportTypes";
import type {
  Viewport3DCapabilities as UnifiedCapabilityReasons,
  Viewport3DControlState,
} from "../model/viewport3dContracts";

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

type QuantityStatus = "ready" | "preview" | "pending" | "unsupported";

interface UnifiedViewportBarProps {
  capabilities: CapabilityMap | UnifiedCapabilityReasons | null;
  renderState: UnifiedRenderState;
  onRenderStateChange: (next: UnifiedRenderState) => void;
  /** Grid Z-depth for layer slider (FDM). */
  gridDepth?: number;
  disabled?: boolean;
  quantityId?: string;
  quantityOptions?: QuantityOption[];
  quantityStatus?: QuantityStatus;
  onQuantityChange?: (quantityId: string) => void;
  clipFlip?: boolean;
  onClipFlipChange?: (next: boolean) => void;
  controlStates?: Partial<Record<string, Viewport3DControlState>>;
  controlReasons?: Partial<Record<string, string | null>>;
}

function labelClass() {
  return "text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground";
}

function controlClass() {
  return "h-7 rounded border border-border/35 bg-background/45 px-1.5 text-[0.72rem]";
}

function quantityStatusClass(status: QuantityStatus): string {
  if (status === "ready") {
    return "border-emerald-400/35 bg-emerald-400/10 text-emerald-200";
  }
  if (status === "preview") {
    return "border-sky-400/35 bg-sky-400/10 text-sky-200";
  }
  if (status === "unsupported") {
    return "border-border/30 bg-muted/20 text-muted-foreground";
  }
  return "border-amber-400/35 bg-amber-400/10 text-amber-200";
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

interface ControlMeta {
  disabled: boolean;
  title?: string;
  state: Viewport3DControlState;
}

function resolveControlMeta(args: {
  key: string;
  fallbackDisabled: boolean;
  fallbackReason?: string;
  controlStates?: Partial<Record<string, Viewport3DControlState>>;
  controlReasons?: Partial<Record<string, string | null>>;
}): ControlMeta {
  const state = args.controlStates?.[args.key];
  const explicitReason = args.controlReasons?.[args.key] ?? undefined;
  const mixedReason =
    explicitReason ??
    "Mixed value across selected entities. Selecting a value will set an explicit state.";
  if (state === "loading") {
    return {
      disabled: true,
      title: explicitReason ?? "Control is loading",
      state,
    };
  }
  if (state === "disabled") {
    return {
      disabled: true,
      title: explicitReason ?? args.fallbackReason,
      state,
    };
  }
  if (state === "mixed") {
    return {
      disabled: args.fallbackDisabled,
      title: args.fallbackDisabled ? args.fallbackReason : mixedReason,
      state,
    };
  }
  return {
    disabled: args.fallbackDisabled,
    title: explicitReason ?? args.fallbackReason,
    state:
      state ??
      (args.fallbackDisabled ? "disabled" : "inactive"),
  };
}

function controlStateClass(state: Viewport3DControlState): string {
  if (state === "mixed") {
    return "ring-1 ring-amber-400/60";
  }
  if (state === "loading") {
    return "opacity-80";
  }
  return "";
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
  quantityStatus = "pending",
  onQuantityChange,
  clipFlip = false,
  onClipFlipChange,
  controlStates,
  controlReasons,
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
  const quantityControl = resolveControlMeta({
    key: "quantity",
    fallbackDisabled: disabled || !supports3D || !onQuantityChange || quantityOptions.length === 0,
    fallbackReason: threeDReason,
    controlStates,
    controlReasons,
  });
  const componentControl = resolveControlMeta({
    key: "component",
    fallbackDisabled: disabled || !supports3D,
    fallbackReason: threeDReason,
    controlStates,
    controlReasons,
  });
  const renderModeControl = resolveControlMeta({
    key: "renderMode",
    fallbackDisabled: disabled || !supportsTopology,
    fallbackReason: topologyReason,
    controlStates,
    controlReasons,
  });
  const clipControl = resolveControlMeta({
    key: "clip",
    fallbackDisabled: disabled || !supportsTopology,
    fallbackReason: topologyReason,
    controlStates,
    controlReasons,
  });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/20 bg-card/10 px-3 py-2 shrink-0">
      <span className={labelClass()}>Quantity</span>
      <select
        className={`${controlClass()} ${controlStateClass(quantityControl.state)}`.trim()}
        value={quantityId ?? ""}
        onChange={(event) => onQuantityChange?.(event.target.value)}
        disabled={quantityControl.disabled}
        title={quantityControl.title}
        data-control-state={quantityControl.state}
      >
        {quantityOptions.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.available}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        className={`rounded border px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-wide ${quantityStatusClass(quantityStatus)}`}
        title={
          quantityStatus === "ready"
            ? "Field resource is available."
            : quantityStatus === "preview"
              ? "Using current preview data."
              : quantityStatus === "unsupported"
                ? "Quantity is not supported by this viewport."
                : "Waiting for field data."
        }
      >
        {quantityStatus}
      </span>

      <span className={labelClass()}>Component</span>
      <select
        className={`${controlClass()} ${controlStateClass(componentControl.state)}`.trim()}
        value={renderState.vectorComponent}
        onChange={(event) =>
          patch({
            vectorComponent: event.target.value as UnifiedRenderState["vectorComponent"],
          })
        }
        disabled={componentControl.disabled}
        title={componentControl.title}
        data-control-state={componentControl.state}
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
        className={`${controlClass()} ${controlStateClass(renderModeControl.state)}`.trim()}
        value={renderState.meshRenderMode ?? "solid"}
        onChange={(event) =>
          patch({
            meshRenderMode: event.target.value as UnifiedRenderState["meshRenderMode"],
          })
        }
        disabled={renderModeControl.disabled}
        title={renderModeControl.title}
        data-control-state={renderModeControl.state}
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
          disabled={clipControl.disabled}
          title={clipControl.title}
          data-control-state={clipControl.state}
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
        disabled={clipControl.disabled || !renderState.clipEnabled}
        title={clipControl.title}
        data-control-state={clipControl.state}
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
        disabled={clipControl.disabled || !renderState.clipEnabled}
        title={clipControl.title}
        data-control-state={clipControl.state}
      />

      <button
        type="button"
        className="h-7 rounded border border-border/35 bg-background/45 px-2 text-[0.68rem] text-foreground disabled:opacity-50"
        onClick={() => onClipFlipChange?.(!clipFlip)}
        disabled={clipControl.disabled || !renderState.clipEnabled || !onClipFlipChange}
        title={
          onClipFlipChange
            ? clipControl.title
            : (baseReason ?? "Clip flip is not exposed by current runtime API")
        }
        data-control-state={clipControl.state}
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

import type { PlanarFieldOverlayState, VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  visualizationStateScopeIdForTarget,
  visualizationTargetKey,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { DIRECTION_COLORMAP } from "@/shared/visualization/directionColor";

type Planar = NonNullable<VisualizationStateResource["planar"]>;

/**
 * Ordered field layer list of the 2D view (`planar.field_overlays`, spec 23
 * §5, ADR 0080). The first layer is drawn on top. Pure helpers; every write
 * sends the whole list.
 */
export const PLANAR_FIELD_LAYERS_MAX = 16;
export type PlanarFieldLayer = PlanarFieldOverlayState;
export type PlanarLayerState = Planar["layers"];
export type PlanarLayerPass = "raster" | "vectors" | "points" | "mesh" | "contours" | "streamlines";
export type PlanarFieldLayerTarget = VisualizationTargetRef | "all";

export const PLANAR_LAYER_PASSES: readonly PlanarLayerPass[] = [
  "raster", "vectors", "points", "mesh", "contours", "streamlines",
];

/** Quantity offered to a layer editor, with its planar component projections. */
export type PlanarFieldQuantityOption = {
  id: string;
  label: string;
  unit: string;
  vector: boolean;
  components: readonly {
    value: string;
    label: string;
    outputKind?: "scalar" | "vector";
  }[];
};

const LAYER_FLAG: Record<PlanarLayerPass, keyof PlanarFieldLayer> = {
  raster: "raster_visible",
  vectors: "vectors_visible",
  points: "points_visible",
  mesh: "mesh_visible",
  contours: "contours_visible",
  streamlines: "streamlines_visible",
};

const DEFAULT_VECTOR_STYLE: PlanarFieldLayer["vector_style"] = {
  length_mode: "uniform",
  color_mode: "orientation",
  scale: 1,
  opacity: 1,
  thickness: 1,
  monochrome_color: "var(--fm-text-primary)",
};

function isAirboxTarget(target: VisualizationTargetRef): boolean {
  return target.kind === "airbox" || visualizationTargetKey(target) === "airbox";
}

/** True for targets that can own a 2D field layer: All objects, Airbox, objects and mesh parts. */
export function fieldLayerTargetSupported(target: PlanarFieldLayerTarget | null | undefined): boolean {
  if (!target) return false;
  return target === "all" || isAirboxTarget(target) || target.kind === "object" || target.kind === "part";
}

export function layerIdForTarget(target: PlanarFieldLayerTarget): string {
  if (target === "all") return "all";
  if (isAirboxTarget(target)) return "airbox";
  if (target.kind === "object") return `object:${visualizationStateScopeIdForTarget(target)}`;
  if (target.kind === "part") return `part:${visualizationStateScopeIdForTarget(target)}`;
  return visualizationTargetKey(target);
}

function viewScopeForTarget(target: PlanarFieldLayerTarget): PlanarFieldLayer["view_scope"] {
  if (target === "all") return { kind: "monitor_target" };
  if (isAirboxTarget(target)) return { kind: "airbox" };
  if (target.kind === "object") return { kind: "object", scope_id: visualizationStateScopeIdForTarget(target) };
  if (target.kind === "part") return { kind: "mesh_part", scope_id: visualizationStateScopeIdForTarget(target) };
  throw new Error(`2D field layers do not support ${target.kind} targets`);
}

/**
 * New layer for a target. Magnetic targets start with the magnetization
 * direction; the Airbox carries no magnetization and starts with H_demag.
 */
export function createFieldLayer(target: PlanarFieldLayerTarget): PlanarFieldLayer {
  const airbox = target !== "all" && isAirboxTarget(target);
  return {
    id: layerIdForTarget(target),
    view_scope: viewScopeForTarget(target),
    quantity_id: airbox ? "H_demag" : "m",
    component: "magnitude",
    colormap: airbox ? "viridis" : DIRECTION_COLORMAP,
    range: { mode: "auto", min: null, max: null },
    raster_opacity: 1,
    visible: true,
    raster_visible: true,
    vectors_visible: false,
    points_visible: false,
    mesh_visible: false,
    contours_visible: false,
    streamlines_visible: false,
    vector_style: { ...DEFAULT_VECTOR_STYLE },
  };
}

export function addFieldLayer(
  layers: readonly PlanarFieldLayer[],
  layer: PlanarFieldLayer,
): { layers: PlanarFieldLayer[] } | { refused: "max_layers" | "duplicate" } {
  if (layers.some((entry) => entry.id === layer.id)) return { refused: "duplicate" };
  if (layers.length >= PLANAR_FIELD_LAYERS_MAX) return { refused: "max_layers" };
  // A new layer goes on top, where the user sees it.
  return { layers: [layer, ...layers] };
}

export function removeFieldLayer(layers: readonly PlanarFieldLayer[], id: string): PlanarFieldLayer[] {
  return layers.filter((layer) => layer.id !== id);
}

export function moveFieldLayer(
  layers: readonly PlanarFieldLayer[],
  id: string,
  toIndex: number,
): PlanarFieldLayer[] {
  const from = layers.findIndex((layer) => layer.id === id);
  if (from < 0) return [...layers];
  const target = Math.min(layers.length - 1, Math.max(0, Math.trunc(toIndex)));
  if (target === from) return [...layers];
  const next = [...layers];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next;
}

/** Patches one layer; its `id` and `view_scope` are its identity and never change. */
export function patchFieldLayer(
  layers: readonly PlanarFieldLayer[],
  id: string,
  patch: Partial<PlanarFieldLayer>,
): PlanarFieldLayer[] {
  return layers.map((layer) => layer.id === id
    ? { ...layer, ...patch, id: layer.id, view_scope: layer.view_scope }
    : layer);
}

export function layerVisible(layer: PlanarFieldLayer): boolean {
  return layer.visible !== false;
}

export function layerPassFlag(layer: PlanarFieldLayer, pass: PlanarLayerPass): boolean {
  return Boolean(layer[LAYER_FLAG[pass]]);
}

export function layerPassPatch(pass: PlanarLayerPass, value: boolean): Partial<PlanarFieldLayer> {
  return { [LAYER_FLAG[pass]]: value };
}

/** View mask AND layer flag (spec 23 §5): "masked" keeps the layer flag on. */
export function effectivePass(
  layer: PlanarFieldLayer,
  viewMasks: PlanarLayerState,
  pass: PlanarLayerPass,
): "on" | "off" | "masked" {
  if (!layerVisible(layer) || !layerPassFlag(layer, pass)) return "off";
  // `streamlines` is absent from masks persisted before the pass existed.
  return viewMasks[pass] === true ? "on" : "masked";
}

/** Multislice draws the first visible layer of the list (ADR 0080 W7). */
export function multisliceLayer(layers: readonly PlanarFieldLayer[]): PlanarFieldLayer | null {
  return layers.find(layerVisible) ?? null;
}

import * as THREE from "three";
import { RENDER_LAYERS, type RenderLayerKey } from "./layers";
import {
  RENDER_POLICIES_V2,
  type RenderPolicyV2,
  type RenderSemantic,
} from "../shared/renderPolicyV2";

/**
 * Material policy: deterministic render settings for each layer.
 * Eliminates ad-hoc decisions scattered across components.
 */
export type RenderPolicy = RenderPolicyV2;

const LAYER_TO_SEMANTIC: Record<RenderLayerKey, RenderSemantic> = {
  OPAQUE_GEOMETRY: "solidSurface",
  TRANSPARENT_CONTEXT: "contextSurface",
  SELECTION_HIGHLIGHT: "selectionShell",
  FIELD_GLYPHS: "glyphs",
  GIZMOS: "gizmos",
  AXES_LABELS: "labels",
  CLIP_CAPS: "interfaceSurface",
  FEATURE_EDGES: "featureEdges",
  HIDDEN_LINE_HELPERS: "hiddenEdges",
  GHOST_CONTEXT: "airSurface",
  PICKING_PROXY: "solidSurface",
  PROBE_MARKERS: "glyphs",
  FIELD_OVERLAY: "boundarySurface",
  SCREENSPACE_HELPERS: "gizmos",
};

/**
 * Returns the deterministic render policy for a given layer.
 * Components use this to configure materials consistently.
 */
export function getRenderPolicy(layer: RenderLayerKey): RenderPolicy {
  return RENDER_POLICIES_V2[LAYER_TO_SEMANTIC[layer]];
}

/**
 * Apply policy props to a Three.js material.
 * Useful for imperative updates (e.g. within useFrame or useEffect).
 */
export function applyRenderPolicy(
  material: THREE.Material,
  layer: RenderLayerKey,
) {
  const p = getRenderPolicy(layer);
  material.side = p.side;
  material.depthWrite = p.depthWrite;
  material.depthTest = p.depthTest;
  material.transparent = p.transparent;
  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial ||
    material instanceof THREE.MeshPhongMaterial ||
    material instanceof THREE.MeshBasicMaterial
  ) {
    material.polygonOffset = p.polygonOffset;
    material.polygonOffsetFactor = p.polygonOffsetFactor;
    material.polygonOffsetUnits = p.polygonOffsetUnits;
  }
  material.needsUpdate = true;
}

/**
 * Assign an object to a render layer.
 */
export function setObjectLayer(obj: THREE.Object3D, layer: RenderLayerKey) {
  obj.layers.set(RENDER_LAYERS[layer]);
}

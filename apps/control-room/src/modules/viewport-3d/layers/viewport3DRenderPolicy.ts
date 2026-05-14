/**
 * viewport3DRenderPolicy — Central render pass policy for the v2 3D viewport.
 *
 * Ported from the legacy `renderPolicyV2.ts` pass table.  Each semantic
 * carries the full set of Three.js material/object properties that ensure
 * deterministic draw ordering, correct depth handling, and no Z-fighting
 * between coplanar surface/wireframe/overlay/selection passes.
 *
 * Usage:
 *   import { RENDER_POLICIES, applyRenderPolicy } from "./viewport3DRenderPolicy";
 *   // on a declarative R3F material:
 *   <meshStandardMaterial {...materialPolicyProps("solidSurface")} />
 *   // on the parent <mesh>:
 *   <mesh renderOrder={RENDER_POLICIES.solidSurface.renderOrder}>
 */

import { BackSide, DoubleSide, FrontSide, type Side } from "three";

export type RenderSemantic =
  | "solidSurface"
  | "contextSurface"
  | "airSurface"
  | "featureEdges"
  | "hiddenEdges"
  | "selectionShell"
  | "glyphs"
  | "points";

export interface RenderPolicy {
  transparent: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  side: Side;
  renderOrder: number;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
}

export const RENDER_POLICIES: Record<RenderSemantic, RenderPolicy> = {
  solidSurface: {
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: FrontSide,
    renderOrder: 0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  },
  contextSurface: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: FrontSide,
    renderOrder: 10,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  },
  airSurface: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: BackSide,
    renderOrder: 11,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  },
  featureEdges: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    renderOrder: 20,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  hiddenEdges: {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    renderOrder: 21,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  selectionShell: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    renderOrder: 30,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  },
  glyphs: {
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: FrontSide,
    renderOrder: 6,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  points: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    renderOrder: 18,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
};

/**
 * Resolves the effective surface policy based on opacity.
 * Opaque surfaces use `solidSurface` (no transparency sorting).
 * Semi-transparent surfaces fall back to `contextSurface`.
 */
export function resolveSurfacePolicy(opacity: number): RenderPolicy {
  return opacity >= 1.0
    ? RENDER_POLICIES.solidSurface
    : RENDER_POLICIES.contextSurface;
}

/**
 * Returns the subset of policy props that can be spread directly onto
 * a declarative R3F material JSX element.
 */
export function materialPolicyProps(semantic: RenderSemantic): {
  transparent: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  side: Side;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
} {
  const policy = RENDER_POLICIES[semantic];
  return {
    transparent: policy.transparent,
    depthWrite: policy.depthWrite,
    depthTest: policy.depthTest,
    side: policy.side,
    polygonOffset: policy.polygonOffset,
    polygonOffsetFactor: policy.polygonOffsetFactor,
    polygonOffsetUnits: policy.polygonOffsetUnits,
  };
}

/**
 * Returns material props for a surface pass that adapts to opacity.
 */
export function surfaceMaterialPolicyProps(opacity: number): {
  transparent: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  side: Side;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
} {
  const policy = resolveSurfacePolicy(opacity);
  return {
    transparent: policy.transparent,
    depthWrite: policy.depthWrite,
    depthTest: policy.depthTest,
    side: policy.side,
    polygonOffset: policy.polygonOffset,
    polygonOffsetFactor: policy.polygonOffsetFactor,
    polygonOffsetUnits: policy.polygonOffsetUnits,
  };
}

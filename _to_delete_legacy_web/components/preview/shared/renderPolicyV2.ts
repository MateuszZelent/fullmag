import * as THREE from "three";

export type RenderSemantic =
  | "solidSurface"
  | "contextSurface"
  | "airSurface"
  | "interfaceSurface"
  | "boundarySurface"
  | "featureEdges"
  | "hiddenEdges"
  | "selectionShell"
  | "hoverShell"
  | "glyphs"
  | "gizmos"
  | "labels"
  | "points";

export interface RenderPolicyV2 {
  transparent: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  side: THREE.Side;
  renderOrder: number;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
}

export const RENDER_POLICIES_V2: Record<RenderSemantic, RenderPolicyV2> = {
  solidSurface: {
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    renderOrder: 0,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  contextSurface: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    renderOrder: 10,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  airSurface: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    renderOrder: 11,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  interfaceSurface: {
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 2,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
  },
  boundarySurface: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 12,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
  },
  featureEdges: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 20,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  hiddenEdges: {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    renderOrder: 21,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  selectionShell: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 30,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  },
  hoverShell: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 31,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  },
  glyphs: {
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    renderOrder: 6,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  gizmos: {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    renderOrder: 40,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  labels: {
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    renderOrder: 41,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
  points: {
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    renderOrder: 18,
    polygonOffset: false,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: 0,
  },
};

export function applyRenderPolicyV2(
  material: THREE.Material,
  semantic: RenderSemantic,
): void {
  const policy = RENDER_POLICIES_V2[semantic];
  material.transparent = policy.transparent;
  material.depthWrite = policy.depthWrite;
  material.depthTest = policy.depthTest;
  material.side = policy.side;

  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial ||
    material instanceof THREE.MeshPhongMaterial ||
    material instanceof THREE.MeshBasicMaterial
  ) {
    material.polygonOffset = policy.polygonOffset;
    material.polygonOffsetFactor = policy.polygonOffsetFactor;
    material.polygonOffsetUnits = policy.polygonOffsetUnits;
  }

  material.needsUpdate = true;
}

export function setRenderOrder(object: THREE.Object3D, semantic: RenderSemantic): void {
  object.renderOrder = RENDER_POLICIES_V2[semantic].renderOrder;
}

// Three.js types are provided by the `three` package since v0.160+.
// Only declare modules for the example JSM imports that lack declarations.
declare module "three/examples/jsm/controls/TrackballControls.js" {
  import { Camera, EventDispatcher } from "three";
  export class TrackballControls extends EventDispatcher {
    constructor(camera: Camera, domElement?: HTMLElement);
    target: import("three").Vector3;
    dynamicDampingFactor: number;
    panSpeed: number;
    rotateSpeed: number;
    update(): void;
    dispose(): void;
  }
}

declare module "three/examples/jsm/controls/OrbitControls.js" {
  import { Camera, EventDispatcher } from "three";
  export class OrbitControls extends EventDispatcher {
    constructor(camera: Camera, domElement?: HTMLElement);
    target: import("three").Vector3;
    update(): void;
    dispose(): void;
  }
}

declare module "three/examples/jsm/utils/BufferGeometryUtils.js" {
  import type { BufferGeometry } from "three";
  export function mergeGeometries(
    geometries: BufferGeometry[],
    useGroups?: boolean
  ): BufferGeometry | null;
}

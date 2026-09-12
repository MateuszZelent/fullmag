import * as THREE from "three";

import {
  applyCameraQuaternionAroundTarget,
  snapCameraToDirection,
} from "./cameraOrientation";

/**
 * Rotate the camera around the current controls target to look from a direction given by a quaternion.
 * Preserves the distance from the target.
 */
export function rotateCameraAroundTarget(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  quat: THREE.Quaternion,
) {
  applyCameraQuaternionAroundTarget(camera, controls, quat);
}

export type CameraPreset = "reset" | "front" | "top" | "right";

/**
 * Set a named camera preset, orbiting around the current controls target.
 */
export function setCameraPresetAroundTarget(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  preset: CameraPreset,
  distance: number,
) {
  let dir: THREE.Vector3;
  let up: THREE.Vector3 | undefined;
  switch (preset) {
    case "reset": dir = new THREE.Vector3(0.75, 0.6, 0.75).normalize(); break;
    case "front": dir = new THREE.Vector3(0, 0, 1); break;
    case "top":   dir = new THREE.Vector3(0, 1, 0); up = new THREE.Vector3(0, 0, -1); break;
    case "right": dir = new THREE.Vector3(1, 0, 0); break;
    default:      dir = new THREE.Vector3(0.75, 0.6, 0.75).normalize(); break;
  }
  snapCameraToDirection(camera, controls, dir, {
    distance,
    up,
  });
}

export interface BoundsBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Focus the camera on a bounding box, preserving the current look direction.
 * Computes the needed orbit distance from the bounds radius and the camera FOV.
 */
export function focusCameraOnBounds(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  bounds: BoundsBox,
  options?: { fallbackMinRadius?: number; preserveDirection?: boolean },
) {
  const target = new THREE.Vector3(
    0.5 * (bounds.min[0] + bounds.max[0]),
    0.5 * (bounds.min[1] + bounds.max[1]),
    0.5 * (bounds.min[2] + bounds.max[2]),
  );
  const size = new THREE.Vector3(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  if ([size.x, size.y, size.z].some((v) => !Number.isFinite(v) || v <= 0)) {
    return;
  }
  const minRadius = options?.fallbackMinRadius ?? 1e-9;
  const radius = Math.max(size.length() * 0.5, minRadius);
  const isOrthographic = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
  const perspCam = camera as THREE.PerspectiveCamera;
  const distance = isOrthographic
    ? Math.max(radius * 3.2, minRadius * 4)
    : Math.max(
        radius / Math.tan(THREE.MathUtils.degToRad(perspCam.fov || 45) * 0.5),
        radius * 2.2,
      );

  let direction: THREE.Vector3;
  if (options?.preserveDirection !== false) {
    direction = camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() < 1e-9) {
      direction = new THREE.Vector3(0.75, 0.6, 0.75).normalize();
    }
  } else {
    direction = new THREE.Vector3(0.75, 0.6, 0.75).normalize();
  }

  camera.position.copy(target).add(direction.multiplyScalar(distance));
  controls.target.copy(target);
  camera.lookAt(target);
  if (isOrthographic) {
    const ortho = camera as THREE.OrthographicCamera;
    const frustumHeight = Math.max(Math.abs(ortho.top - ortho.bottom), 1);
    ortho.zoom = frustumHeight / Math.max(radius * 4, minRadius * 2);
    ortho.updateProjectionMatrix();
  } else {
    perspCam.updateProjectionMatrix?.();
  }
  controls.update();
}

/**
 * Auto-fit the camera to a bounding sphere. Sets near/far planes.
 */
export function fitCameraToBounds(
  camera: THREE.Camera,
  maxDim: number,
  targetCenter?: THREE.Vector3,
  controls?: { target: THREE.Vector3; update(): void } | null,
) {
  if (maxDim <= 0) return;
  const d = maxDim * 2;
  const center = targetCenter ?? new THREE.Vector3(0, 0, 0);
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    ortho.near = maxDim * 0.001;
    ortho.far = maxDim * 200;
    const frustumHeight = Math.max(Math.abs(ortho.top - ortho.bottom), 1);
    ortho.zoom = frustumHeight / Math.max(maxDim * 2.4, 1e-9);
    camera.position.set(center.x + d * 0.75, center.y + d * 0.6, center.z + d * 0.75);
    camera.lookAt(center);
    ortho.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    return;
  }
  const perspCam = camera as THREE.PerspectiveCamera;
  perspCam.near = maxDim * 0.001;
  perspCam.far = maxDim * 200;
  camera.position.set(center.x + d * 0.75, center.y + d * 0.6, center.z + d * 0.75);
  camera.lookAt(center);
  perspCam.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
}

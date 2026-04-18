import * as THREE from "three";

export type Direction3 = [number, number, number];

export interface CameraControlsLike {
  target: THREE.Vector3;
  update(): void;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface SceneCameraHandle {
  camera: THREE.Camera;
  controls?: CameraControlsLike | null;
}

export interface OrientationDebugSnapshot {
  quaternion: [number, number, number, number];
  eulerDeg: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
  position: [number, number, number];
  signature: string;
  cssTransform: string;
}

const EPSILON = 1e-6;
const DEFAULT_WORLD_UP = new THREE.Vector3(0, 1, 0);
const POLAR_WORLD_UP = new THREE.Vector3(0, 0, -1);

const _cameraQuat = new THREE.Quaternion();
const _cameraMatrix = new THREE.Matrix4();
const _cameraDirection = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _cameraSide = new THREE.Vector3();
const _cameraOffset = new THREE.Vector3();
const _cameraSpherical = new THREE.Spherical();
const _cameraEuler = new THREE.Euler();

function ensureDirectionVector(direction: Direction3 | THREE.Vector3): THREE.Vector3 {
  if (direction instanceof THREE.Vector3) {
    _cameraDirection.copy(direction);
  } else {
    _cameraDirection.set(direction[0], direction[1], direction[2]);
  }
  if (_cameraDirection.lengthSq() <= EPSILON) {
    _cameraDirection.set(0, 0, 1);
  }
  return _cameraDirection.normalize();
}

export function normalizeDirection(direction: Direction3 | THREE.Vector3): Direction3 {
  const normalized = ensureDirectionVector(direction);
  return [normalized.x, normalized.y, normalized.z];
}

export function cameraOrientationSignature(camera: THREE.Camera): string {
  _cameraQuat.copy(camera.quaternion);
  if (_cameraQuat.w < 0) {
    _cameraQuat.set(-_cameraQuat.x, -_cameraQuat.y, -_cameraQuat.z, -_cameraQuat.w);
  }
  return [_cameraQuat.x, _cameraQuat.y, _cameraQuat.z, _cameraQuat.w]
    .map((value) => value.toFixed(6))
    .join("|");
}

export function cameraOrientationCssTransform(camera: THREE.Camera): string {
  camera.updateMatrixWorld(true);
  _cameraMatrix.copy(camera.matrixWorldInverse);
  _cameraMatrix.elements[12] = 0;
  _cameraMatrix.elements[13] = 0;
  _cameraMatrix.elements[14] = 0;
  const elements = _cameraMatrix.elements;
  return `matrix3d(${elements[0]},${elements[1]},${elements[2]},0,${elements[4]},${elements[5]},${elements[6]},0,${elements[8]},${elements[9]},${elements[10]},0,0,0,0,1)`;
}

export function captureOrientationDebugSnapshot(camera: THREE.Camera): OrientationDebugSnapshot {
  camera.updateMatrixWorld(true);
  _cameraQuat.copy(camera.quaternion);
  _cameraUp.copy(camera.up).normalize();
  _cameraDirection.set(0, 0, -1).applyQuaternion(_cameraQuat).normalize();
  _cameraEuler.setFromQuaternion(_cameraQuat, "XYZ");
  return {
    quaternion: [_cameraQuat.x, _cameraQuat.y, _cameraQuat.z, _cameraQuat.w],
    eulerDeg: [
      THREE.MathUtils.radToDeg(_cameraEuler.x),
      THREE.MathUtils.radToDeg(_cameraEuler.y),
      THREE.MathUtils.radToDeg(_cameraEuler.z),
    ],
    up: [_cameraUp.x, _cameraUp.y, _cameraUp.z],
    forward: [_cameraDirection.x, _cameraDirection.y, _cameraDirection.z],
    position: [camera.position.x, camera.position.y, camera.position.z],
    signature: cameraOrientationSignature(camera),
    cssTransform: cameraOrientationCssTransform(camera),
  };
}

export function pickCameraUpVector(direction: Direction3 | THREE.Vector3): Direction3 {
  const normalized = ensureDirectionVector(direction);
  if (Math.abs(normalized.y) > 0.94) {
    return [0, 0, normalized.y > 0 ? -1 : 1];
  }

  _cameraUp.copy(DEFAULT_WORLD_UP);
  _cameraSide.crossVectors(normalized, _cameraUp);
  if (_cameraSide.lengthSq() <= EPSILON) {
    _cameraUp.copy(POLAR_WORLD_UP);
    _cameraSide.crossVectors(normalized, _cameraUp);
  }

  _cameraSide.normalize();
  _cameraUp.crossVectors(_cameraSide, normalized).normalize();
  return [_cameraUp.x, _cameraUp.y, _cameraUp.z];
}

function updateProjection(camera: THREE.Camera): void {
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    return;
  }
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    (camera as THREE.OrthographicCamera).updateProjectionMatrix();
  }
}

export function quaternionFromViewDirection(
  direction: Direction3 | THREE.Vector3,
  up?: Direction3 | THREE.Vector3,
): THREE.Quaternion {
  const normalized = ensureDirectionVector(direction);
  const resolvedUp = up ? normalizeDirection(up) : pickCameraUpVector(normalized);
  _cameraUp.set(resolvedUp[0], resolvedUp[1], resolvedUp[2]).normalize();
  _cameraSide.crossVectors(_cameraUp, normalized);
  if (_cameraSide.lengthSq() <= EPSILON) {
    const fallbackUp = pickCameraUpVector(normalized);
    _cameraUp.set(fallbackUp[0], fallbackUp[1], fallbackUp[2]).normalize();
    _cameraSide.crossVectors(_cameraUp, normalized);
  }
  _cameraSide.normalize();
  _cameraUp.crossVectors(normalized, _cameraSide).normalize();
  _cameraMatrix.makeBasis(_cameraSide, _cameraUp, normalized);
  return new THREE.Quaternion().setFromRotationMatrix(_cameraMatrix);
}

export function applyCameraQuaternionAroundTarget(
  camera: THREE.Camera,
  controls: CameraControlsLike,
  quaternion: THREE.Quaternion,
): THREE.Quaternion {
  const target = controls.target.clone();
  const distance = camera.position.clone().sub(target).length() || 1;
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
  camera.position.copy(target).add(direction.multiplyScalar(distance));
  camera.up.copy(up);
  camera.lookAt(target);
  controls.target.copy(target);
  updateProjection(camera);
  controls.update();
  return camera.quaternion.clone();
}

export function snapCameraToDirection(
  camera: THREE.Camera,
  controls: CameraControlsLike,
  direction: Direction3 | THREE.Vector3,
  options?: {
    up?: Direction3 | THREE.Vector3;
    distance?: number;
  },
): THREE.Quaternion {
  const normalized = ensureDirectionVector(direction);
  const up = options?.up ? normalizeDirection(options.up) : pickCameraUpVector(normalized);
  const target = controls.target.clone();
  const distance = options?.distance ?? (camera.position.clone().sub(target).length() || 1);

  camera.position.copy(target).addScaledVector(normalized, distance);
  camera.up.set(up[0], up[1], up[2]);
  camera.lookAt(target);
  controls.target.copy(target);
  updateProjection(camera);
  controls.update();
  return camera.quaternion.clone();
}

export function orbitCameraAroundTarget(
  camera: THREE.Camera,
  controls: CameraControlsLike,
  deltaTheta: number,
  deltaPhi: number,
  options?: {
    minPhi?: number;
    maxPhi?: number;
  },
): THREE.Quaternion {
  _cameraOffset.copy(camera.position).sub(controls.target);
  _cameraSpherical.setFromVector3(_cameraOffset);
  _cameraSpherical.theta += deltaTheta;
  _cameraSpherical.phi += deltaPhi;
  _cameraSpherical.phi = THREE.MathUtils.clamp(
    _cameraSpherical.phi,
    options?.minPhi ?? 0.02,
    options?.maxPhi ?? Math.PI - 0.02,
  );
  _cameraOffset.setFromSpherical(_cameraSpherical);
  camera.position.copy(controls.target).add(_cameraOffset);
  camera.lookAt(controls.target);
  updateProjection(camera);
  controls.update();
  return camera.quaternion.clone();
}

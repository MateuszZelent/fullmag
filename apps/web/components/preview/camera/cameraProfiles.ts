import * as THREE from "three";

export type CameraControlProfileId = "fem" | "fdm";

export type CameraControlProfile = {
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  dampingFactor: number;
  minRotationStep: number;
  minPanStep: number;
  minZoomStep: number;
};

const EPS = 1e-9;

export const CAMERA_CONTROL_PROFILES: Record<CameraControlProfileId, CameraControlProfile> = {
  fem: {
    // Preciser 3D CAD-style handling for FEM scenes.
    rotateSpeed: 0.62,
    zoomSpeed: 0.82,
    panSpeed: 0.65,
    dampingFactor: 0.12,
    minRotationStep: 0,
    minPanStep: 0,
    minZoomStep: 0,
  },
  fdm: {
    // Preciser navigation profile for FDM scenes (slightly slower pan/rotate).
    rotateSpeed: 0.58,
    zoomSpeed: 0.74,
    panSpeed: 0.58,
    dampingFactor: 0.10,
    minRotationStep: 0,
    minPanStep: 0,
    minZoomStep: 0,
  },
};

export type CameraStepLockState = {
  initialized: boolean;
  rotation: THREE.Quaternion;
  target: THREE.Vector3;
  cameraPosition: THREE.Vector3;
};

export function createCameraStepLockState(): CameraStepLockState {
  return {
    initialized: false,
    rotation: new THREE.Quaternion(),
    target: new THREE.Vector3(),
    cameraPosition: new THREE.Vector3(),
  };
}

function safeProfileValue(value: number): boolean {
  return Number.isFinite(value) && value > EPS;
}

function getControlTarget(controls: { target: THREE.Vector3 } | null): THREE.Vector3 | null {
  return controls?.target ? controls.target : null;
}

export function applyCameraStepLock({
  camera,
  controls,
  profile,
  state,
}: {
  camera: THREE.Camera;
  controls: { target: THREE.Vector3 } | null;
  profile: CameraControlProfile;
  state: CameraStepLockState;
}): boolean {
  if (!safeProfileValue(profile.minRotationStep) && !safeProfileValue(profile.minPanStep) && !safeProfileValue(profile.minZoomStep)) {
    return false;
  }

  const hasTarget = Boolean(getControlTarget(controls));
  const target = getControlTarget(controls);
  let snapped = false;

  if (!state.initialized) {
    state.initialized = true;
    state.rotation.copy(camera.quaternion);
    if (target) {
      state.target.copy(target);
    }
    state.cameraPosition.copy(camera.position);
    return false;
  }

  if (safeProfileValue(profile.minRotationStep)) {
    const rotationDelta = state.rotation.angleTo(camera.quaternion);
    if (rotationDelta > EPS && rotationDelta < profile.minRotationStep) {
      camera.quaternion.copy(state.rotation);
      snapped = true;
    } else {
      state.rotation.copy(camera.quaternion);
    }
  }

  if (hasTarget) {
    if (safeProfileValue(profile.minPanStep)) {
      const panDelta = target!.distanceTo(state.target);
      if (panDelta > EPS && panDelta < profile.minPanStep) {
        target!.copy(state.target);
        camera.position.copy(state.cameraPosition);
        snapped = true;
      } else {
        state.target.copy(target!);
      }
    }

    if (safeProfileValue(profile.minZoomStep)) {
      const radiusNow = camera.position.distanceTo(target!);
      const radiusRef = state.cameraPosition.distanceTo(state.target);
      const zoomDelta = Math.abs(radiusNow - radiusRef);
      if (zoomDelta > EPS && zoomDelta < profile.minZoomStep) {
        const direction = state.cameraPosition.clone().sub(state.target).normalize();
        camera.position.copy(state.target).add(direction.multiplyScalar(radiusRef));
        snapped = true;
      } else {
        state.cameraPosition.copy(camera.position);
      }
    } else {
      state.cameraPosition.copy(camera.position);
    }
  } else if (!hasTarget && safeProfileValue(profile.minZoomStep)) {
    state.cameraPosition.copy(camera.position);
  }

  if (hasTarget && !(target as THREE.Vector3).equals(state.target)) {
    state.target.copy(target!);
  }
  if (!hasTarget && safeProfileValue(profile.minPanStep)) {
    state.target.set(0, 0, 0);
  }
  if (!safeProfileValue(profile.minZoomStep)) {
    state.cameraPosition.copy(camera.position);
  } else if (hasTarget && !snapped) {
    state.cameraPosition.copy(camera.position);
  }

  return snapped;
}

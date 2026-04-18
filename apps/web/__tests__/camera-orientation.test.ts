import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  pickCameraUpVector,
  quaternionFromViewDirection,
  snapCameraToDirection,
} from "../components/preview/camera/cameraOrientation";

function expectVectorClose(
  actual: THREE.Vector3,
  expected: [number, number, number],
  precision = 6,
): void {
  expect(actual.x).toBeCloseTo(expected[0], precision);
  expect(actual.y).toBeCloseTo(expected[1], precision);
  expect(actual.z).toBeCloseTo(expected[2], precision);
}

describe("pickCameraUpVector", () => {
  it("uses -Z as up for a top-down view", () => {
    expect(pickCameraUpVector([0, 1, 0])).toEqual([0, 0, -1]);
  });

  it("uses +Z as up for a bottom-up view", () => {
    expect(pickCameraUpVector([0, -1, 0])).toEqual([0, 0, 1]);
  });
});

describe("quaternionFromViewDirection", () => {
  it("produces a quaternion whose forward and up vectors match the snapped view", () => {
    const quaternion = quaternionFromViewDirection([0, 1, 0]);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();

    expectVectorClose(forward, [0, 1, 0]);
    expectVectorClose(up, [0, 0, -1]);
  });
});

describe("snapCameraToDirection", () => {
  it("preserves orbit distance while snapping the camera and roll", () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(3, 2, 4);
    camera.up.set(0, 1, 0);

    const controls = {
      target: new THREE.Vector3(0, 0, 0),
      update() {},
    };

    const distanceBefore = camera.position.length();
    snapCameraToDirection(camera, controls, [0, 1, 0]);

    expect(camera.position.length()).toBeCloseTo(distanceBefore, 6);
    expectVectorClose(camera.position.clone().normalize(), [0, 1, 0]);
    expectVectorClose(camera.up.clone().normalize(), [0, 0, -1]);
  });
});

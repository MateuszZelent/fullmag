import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  swapYZQuat,
  swapYZVec3,
} from "../components/preview/transform/axisConvention";

function matrix3FromQuat(q: [number, number, number, number]): THREE.Matrix3 {
  const m4 = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...q));
  const e = m4.elements;
  return new THREE.Matrix3().set(
    e[0], e[4], e[8],
    e[1], e[5], e[9],
    e[2], e[6], e[10],
  );
}

function conjugateBySwapYZ(mat: THREE.Matrix3): THREE.Matrix3 {
  const p = new THREE.Matrix3().set(
    1, 0, 0,
    0, 0, 1,
    0, 1, 0,
  );
  return new THREE.Matrix3().multiplyMatrices(
    p,
    new THREE.Matrix3().multiplyMatrices(mat, p),
  );
}

function expectMatricesClose(actual: THREE.Matrix3, expected: THREE.Matrix3): void {
  for (let index = 0; index < actual.elements.length; index += 1) {
    expect(actual.elements[index]).toBeCloseTo(expected.elements[index], 12);
  }
}

describe("swapYZVec3", () => {
  it("swaps the Y and Z components", () => {
    expect(swapYZVec3([1, 2, 3])).toEqual([1, 3, 2]);
  });
});

describe("swapYZQuat", () => {
  it("matches matrix conjugation for a rotation around X", () => {
    const original = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
      .toArray() as [number, number, number, number];
    const expected = conjugateBySwapYZ(matrix3FromQuat(original));
    const actual = matrix3FromQuat(swapYZQuat(original));
    expectMatricesClose(actual, expected);
  });

  it("matches matrix conjugation for a rotation around Y", () => {
    const original = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3)
      .toArray() as [number, number, number, number];
    const expected = conjugateBySwapYZ(matrix3FromQuat(original));
    const actual = matrix3FromQuat(swapYZQuat(original));
    expectMatricesClose(actual, expected);
  });

  it("matches matrix conjugation for a general quaternion", () => {
    const original = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0.37, -0.81, 1.14, "XYZ"))
      .toArray() as [number, number, number, number];
    const expected = conjugateBySwapYZ(matrix3FromQuat(original));
    const actual = matrix3FromQuat(swapYZQuat(original));
    expectMatricesClose(actual, expected);
  });

  it("is its own inverse up to quaternion equivalence", () => {
    const original: [number, number, number, number] = [0.13, -0.28, 0.44, 0.84];
    expect(swapYZQuat(swapYZQuat(original))).toEqual(original);
  });
});

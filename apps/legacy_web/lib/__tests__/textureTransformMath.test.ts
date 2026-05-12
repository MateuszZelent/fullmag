import { describe, expect, it } from "vitest";
import * as THREE from "three";

import type { TextureTransform3D } from "@/lib/textureTransform";
import {
  composePivotedTextureTransformMatrix,
  textureTransformFromPivotMatrix,
} from "@/lib/textureTransformMath";
import {
  textureTransformToLocal,
  textureTransformToWorld,
} from "@/components/runs/control-room/viewportUtils";

function expectVecClose(actual: number[], expected: number[], digits = 12) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], digits);
  });
}

describe("composePivotedTextureTransformMatrix", () => {
  it("matches the backend pivot formula for scale around a local pivot", () => {
    const transform: TextureTransform3D = {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [2, 1, 1],
      pivot: [1, 0, 0],
    };
    const matrix = composePivotedTextureTransformMatrix(transform);
    const point = new THREE.Vector3(2 - transform.pivot[0], 0, 0).applyMatrix4(matrix);

    expect(point.toArray()).toEqual([3, 0, 0]);
  });

  it("round-trips translation, rotation and scale when decoded with the same pivot", () => {
    const transform: TextureTransform3D = {
      translation: [3, -2, 5],
      rotation_quat: new THREE.Quaternion()
        .setFromEuler(new THREE.Euler(0.4, -0.2, 0.7, "XYZ"))
        .toArray() as [number, number, number, number],
      scale: [2, 3, 4],
      pivot: [1, -1, 0.5],
    };

    const matrix = composePivotedTextureTransformMatrix(transform);
    const decoded = textureTransformFromPivotMatrix(matrix, transform.pivot);

    expectVecClose(decoded.translation, transform.translation);
    expectVecClose(decoded.scale, transform.scale);
    decoded.rotation_quat.forEach((value, index) => {
      expect(value).toBeCloseTo(transform.rotation_quat[index], 12);
    });
  });
});

describe("textureTransformToWorld / textureTransformToLocal", () => {
  it("does not apply object translation to local pivot twice", () => {
    const objectTransform = {
      translation: [10, 0, 0] as [number, number, number],
      rotation_quat: [0, 0, 0, 1] as [number, number, number, number],
      scale: [2, 3, 4] as [number, number, number],
    };
    const textureTransform: TextureTransform3D = {
      translation: [1, 2, 3],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [4, 5, 6],
    };

    const world = textureTransformToWorld(textureTransform, objectTransform);

    expect(world.translation).toEqual([12, 6, 12]);
    expect(world.pivot).toEqual([8, 15, 24]);

    const local = textureTransformToLocal(world, objectTransform);
    expectVecClose(local.translation, textureTransform.translation);
    expectVecClose(local.rotation_quat, textureTransform.rotation_quat);
    expectVecClose(local.scale, textureTransform.scale);
    expectVecClose(local.pivot, textureTransform.pivot);
  });

  it("round-trips a rotated object transform", () => {
    const objectTransform = {
      translation: [5, -3, 0] as [number, number, number],
      rotation_quat: new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
        .toArray() as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const textureTransform: TextureTransform3D = {
      translation: [1, 0, 0],
      rotation_quat: new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 4)
        .toArray() as [number, number, number, number],
      scale: [2, 1, 1],
      pivot: [0, 2, 0],
    };

    const world = textureTransformToWorld(textureTransform, objectTransform);

    expect(world.translation[0]).toBeCloseTo(5, 12);
    expect(world.translation[1]).toBeCloseTo(-2, 12);
    expect(world.pivot[0]).toBeCloseTo(-2, 12);
    expect(world.pivot[1]).toBeCloseTo(0, 12);

    const local = textureTransformToLocal(world, objectTransform);
    expectVecClose(local.translation, textureTransform.translation);
    expectVecClose(local.rotation_quat, textureTransform.rotation_quat);
    expectVecClose(local.scale, textureTransform.scale);
    expectVecClose(local.pivot, textureTransform.pivot);
  });
});

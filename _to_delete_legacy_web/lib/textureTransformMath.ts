import * as THREE from "three";

import type { TextureTransform3D } from "./textureTransform";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface AffineTransform3D {
  translation: Vec3;
  rotation_quat: Quat;
  scale: Vec3;
}

export interface PivotFrameTransform3D extends AffineTransform3D {
  pivot: Vec3;
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function negateVec3(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

export function scaleVec3Components(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function inverseScaleVec3(scale: Vec3): Vec3 {
  return [
    scale[0] !== 0 ? 1 / scale[0] : 0,
    scale[1] !== 0 ? 1 / scale[1] : 0,
    scale[2] !== 0 ? 1 / scale[2] : 0,
  ];
}

export function quatRotateVec3(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function quatInverse(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function applyLinearTransformToPoint(point: Vec3, transform: AffineTransform3D): Vec3 {
  return quatRotateVec3(transform.rotation_quat, scaleVec3Components(point, transform.scale));
}

export function applyAffineTransformToPoint(point: Vec3, transform: AffineTransform3D): Vec3 {
  return addVec3(transform.translation, applyLinearTransformToPoint(point, transform));
}

export function removeLinearTransformFromPoint(point: Vec3, transform: AffineTransform3D): Vec3 {
  return scaleVec3Components(
    quatRotateVec3(quatInverse(transform.rotation_quat), point),
    inverseScaleVec3(transform.scale),
  );
}

export function removeAffineTransformFromPoint(point: Vec3, transform: AffineTransform3D): Vec3 {
  return removeLinearTransformFromPoint(subVec3(point, transform.translation), transform);
}

export function textureTransformToPivotFrame(
  transform: TextureTransform3D,
): {
  position: Vec3;
  rotation_quat: Quat;
  scale: Vec3;
  childOffset: Vec3;
} {
  return {
    position: addVec3(transform.translation, transform.pivot),
    rotation_quat: [...transform.rotation_quat] as Quat,
    scale: [...transform.scale] as Vec3,
    childOffset: negateVec3(transform.pivot),
  };
}

export function composePivotedTextureTransformMatrix(
  transform: TextureTransform3D,
  matrix = new THREE.Matrix4(),
): THREE.Matrix4 {
  const frame = textureTransformToPivotFrame(transform);
  matrix.compose(
    new THREE.Vector3(...frame.position),
    new THREE.Quaternion(...frame.rotation_quat),
    new THREE.Vector3(...frame.scale),
  );
  return matrix;
}

export function textureTransformFromPivotMatrix(
  matrix: THREE.Matrix4,
  pivot: Vec3,
): TextureTransform3D {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);

  return {
    translation: [position.x - pivot[0], position.y - pivot[1], position.z - pivot[2]],
    rotation_quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    scale: [scale.x, scale.y, scale.z],
    pivot: [...pivot],
  };
}

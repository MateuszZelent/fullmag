import * as THREE from "three";
import type { ObjectTransform, SnapConfig, TransformSpace } from "./types";

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Apply a delta transform to a baseline transform.
 * Translation is applied in the given space; rotation is composed.
 */
export function applyTransform(
  base: ObjectTransform,
  delta: ObjectTransform,
  space: TransformSpace,
): ObjectTransform {
  // Translation
  const dt = new THREE.Vector3(...delta.translation);
  if (space === "local") {
    // Rotate translation into base orientation
    _q.set(...base.rotation);
    dt.applyQuaternion(_q);
  }
  const translation: [number, number, number] = [
    base.translation[0] + dt.x,
    base.translation[1] + dt.y,
    base.translation[2] + dt.z,
  ];

  // Rotation (compose: base * delta)
  const bq = new THREE.Quaternion(...base.rotation);
  const dq = new THREE.Quaternion(...delta.rotation);
  const rq = bq.multiply(dq);
  const rotation: [number, number, number, number] = [rq.x, rq.y, rq.z, rq.w];

  // Scale (multiply)
  const scale: [number, number, number] = [
    base.scale[0] * delta.scale[0],
    base.scale[1] * delta.scale[1],
    base.scale[2] * delta.scale[2],
  ];

  return { translation, rotation, scale };
}

/**
 * Snap a translation delta to increments.
 */
export function snappedTranslation(
  delta: [number, number, number],
  snap: SnapConfig,
): [number, number, number] {
  if (!snap.enabled || snap.moveIncrement <= 0) return delta;
  const s = snap.moveIncrement;
  return [
    Math.round(delta[0] / s) * s,
    Math.round(delta[1] / s) * s,
    Math.round(delta[2] / s) * s,
  ];
}

/**
 * Snap a rotation (euler radians) to degree increments.
 */
export function snappedRotation(
  eulerRad: [number, number, number],
  snap: SnapConfig,
): [number, number, number] {
  if (!snap.enabled || snap.rotateDegrees <= 0) return eulerRad;
  const step = THREE.MathUtils.degToRad(snap.rotateDegrees);
  return [
    Math.round(eulerRad[0] / step) * step,
    Math.round(eulerRad[1] / step) * step,
    Math.round(eulerRad[2] / step) * step,
  ];
}

/**
 * Snap scale values to increments.
 */
export function snappedScale(
  scale: [number, number, number],
  snap: SnapConfig,
): [number, number, number] {
  if (!snap.enabled || snap.scaleIncrement <= 0) return scale;
  const s = snap.scaleIncrement;
  return [
    Math.round(scale[0] / s) * s,
    Math.round(scale[1] / s) * s,
    Math.round(scale[2] / s) * s,
  ];
}

/**
 * Extract translation delta from a Three.js Matrix4 (e.g. from TransformControls).
 */
export function translationFromMatrix(mat: THREE.Matrix4): [number, number, number] {
  _v.setFromMatrixPosition(mat);
  return [_v.x, _v.y, _v.z];
}

/**
 * Extract rotation as quaternion from a Three.js Matrix4.
 */
export function rotationFromMatrix(mat: THREE.Matrix4): [number, number, number, number] {
  _q.setFromRotationMatrix(mat);
  return [_q.x, _q.y, _q.z, _q.w];
}

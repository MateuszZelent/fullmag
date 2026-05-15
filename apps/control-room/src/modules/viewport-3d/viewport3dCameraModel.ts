import { VIEWPORT_3D_WORLD_UP } from "./layers/CameraControls";
import type { Viewport3DCameraState } from "./viewport3dStore";

export interface Viewport3DCameraOrientation {
  distance: number;
  pitchDegrees: number;
  rollDegrees: number;
  yawDegrees: number;
}

export interface Viewport3DCameraPose
  extends Viewport3DCameraState {
  up: [number, number, number];
}

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const EPSILON = 1e-18;

export function resolveViewport3DCameraOrientation({
  position,
  target,
  up = VIEWPORT_3D_WORLD_UP,
}: Viewport3DCameraState & {
  up?: readonly number[];
}): Viewport3DCameraOrientation {
  const offset = subtract(position, target);
  const distance = vectorLength(offset);
  if (distance <= EPSILON) {
    return {
      distance: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
      yawDegrees: 0,
    };
  }

  const horizontal = Math.hypot(offset[0], offset[1]);
  const yawDegrees = normalizeAngleDegrees(
    Math.atan2(offset[1], offset[0]) * DEG_PER_RAD,
  );
  const pitchDegrees = Math.atan2(offset[2], horizontal) * DEG_PER_RAD;
  const forward = normalize(subtract(target, position));
  const baseUp = resolveReferenceUp(forward);
  const actualUp = normalize(projectOntoCameraPlane(toTuple(up), forward));
  const rollDegrees = normalizeSignedAngleDegrees(
    Math.atan2(
      dot(cross(baseUp, actualUp), forward),
      dot(baseUp, actualUp),
    ) * DEG_PER_RAD,
  );

  return {
    distance,
    pitchDegrees,
    rollDegrees,
    yawDegrees,
  };
}

export function buildViewport3DCameraPoseFromOrientation({
  distance,
  pitchDegrees,
  rollDegrees,
  target,
  yawDegrees,
}: Viewport3DCameraOrientation & {
  target: [number, number, number];
}): Viewport3DCameraPose {
  const pitch = pitchDegrees * RAD_PER_DEG;
  const yaw = yawDegrees * RAD_PER_DEG;
  const safeDistance = Math.max(distance, 0);
  const offset: [number, number, number] = [
    safeDistance * Math.cos(pitch) * Math.cos(yaw),
    safeDistance * Math.cos(pitch) * Math.sin(yaw),
    safeDistance * Math.sin(pitch),
  ];
  const position = add(target, offset);
  const forward = normalize(subtract(target, position));
  const referenceUp = resolveReferenceUp(forward);
  const up = rotateAroundAxis(referenceUp, forward, rollDegrees * RAD_PER_DEG);

  return { position, target, up };
}

export function toCameraTuple(
  values: readonly number[],
  fallback: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  return [
    finiteOrFallback(values[0], fallback[0]),
    finiteOrFallback(values[1], fallback[1]),
    finiteOrFallback(values[2], fallback[2]),
  ];
}

function add(
  left: [number, number, number],
  right: [number, number, number],
): [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(
  left: readonly number[],
  right: readonly number[],
): [number, number, number] {
  return [
    finiteOrFallback(left[0], 0) - finiteOrFallback(right[0], 0),
    finiteOrFallback(left[1], 0) - finiteOrFallback(right[1], 0),
    finiteOrFallback(left[2], 0) - finiteOrFallback(right[2], 0),
  ];
}

function dot(left: [number, number, number], right: [number, number, number]) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(
  left: [number, number, number],
  right: [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function vectorLength(vector: [number, number, number]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = vectorLength(vector);
  if (length <= EPSILON) return [1, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function projectOntoCameraPlane(
  vector: [number, number, number],
  forward: [number, number, number],
): [number, number, number] {
  const amount = dot(vector, forward);
  return [
    vector[0] - forward[0] * amount,
    vector[1] - forward[1] * amount,
    vector[2] - forward[2] * amount,
  ];
}

function resolveReferenceUp(
  forward: [number, number, number],
): [number, number, number] {
  const projectedWorldUp = projectOntoCameraPlane(VIEWPORT_3D_WORLD_UP, forward);
  if (vectorLength(projectedWorldUp) > EPSILON) {
    return normalize(projectedWorldUp);
  }
  return normalize(projectOntoCameraPlane([0, 1, 0], forward));
}

function rotateAroundAxis(
  vector: [number, number, number],
  axis: [number, number, number],
  angle: number,
): [number, number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const axisDot = dot(axis, vector);
  const axisCross = cross(axis, vector);

  return normalize([
    vector[0] * cos + axisCross[0] * sin + axis[0] * axisDot * (1 - cos),
    vector[1] * cos + axisCross[1] * sin + axis[1] * axisDot * (1 - cos),
    vector[2] * cos + axisCross[2] * sin + axis[2] * axisDot * (1 - cos),
  ]);
}

function toTuple(values: readonly number[]): [number, number, number] {
  return toCameraTuple(values);
}

function finiteOrFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeAngleDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeSignedAngleDegrees(value: number): number {
  const normalized = normalizeAngleDegrees(value);
  return normalized > 180 ? normalized - 360 : normalized;
}

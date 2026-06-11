import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Path,
  Shape,
  SphereGeometry,
} from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  Viewport3DBoxCylinderDifferencePreview,
  Viewport3DPrimitiveObject,
} from "../viewport3dPrimitiveModel";

export function trackPrimitiveObjectGeometry(
  tracker: Viewport3DResourceTracker,
  object: Viewport3DPrimitiveObject,
): BufferGeometry {
  return tracker.track("geometry", createPrimitiveObjectGeometry(object));
}

export function releasePrimitiveObjectGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry,
): void {
  tracker.release("geometry", geometry);
}

export function buildPrimitiveTransformGizmoSegments(
  object: Viewport3DPrimitiveObject,
): Float32Array {
  const length = Math.max(Math.max(...object.bounds.size) * 0.36, 1e-12);
  return Float32Array.from([
    0, 0, 0,
    length, 0, 0,
    0, 0, 0,
    0, length, 0,
    0, 0, 0,
    0, 0, length,
  ]);
}

export function shouldRenderPrimitiveTransformGizmo(
  settings: VisualizationTargetSettings,
): boolean {
  return settings.visible && settings.wireframeVisible;
}

export function createPrimitiveObjectGeometry(
  object: Viewport3DPrimitiveObject,
): BufferGeometry {
  if (object.kind === "box-cylinder-difference" && object.csgPreview) {
    return createBoxCylinderDifferenceGeometry(object.csgPreview);
  }

  const [x, y, z] = object.bounds.size;
  if (object.kind === "sphere") {
    return new SphereGeometry(Math.max(x, y, z) / 2, 32, 16);
  }
  if (object.kind === "cylinder") {
    return new CylinderGeometry(x / 2, x / 2, y, 32, 1);
  }
  return new BoxGeometry(x, y, z);
}

function createBoxCylinderDifferenceGeometry(
  preview: Viewport3DBoxCylinderDifferencePreview,
): BufferGeometry {
  const [x, y, z] = preview.boxSize;
  const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
  if (axisIndex === null) {
    return new BoxGeometry(x, y, z);
  }

  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const depth = Math.max(preview.boxSize[axisIndex], 1e-12);
  const planeWidth = Math.max(preview.boxSize[planeAxes[0]], 1e-12);
  const planeHeight = Math.max(preview.boxSize[planeAxes[1]], 1e-12);
  const halfWidth = planeWidth / 2;
  const halfHeight = planeHeight / 2;
  const radius = Math.min(
    Math.max(preview.cylinderRadius, 1e-12),
    Math.max(Math.min(halfWidth, halfHeight) * 0.98, 1e-12),
  );
  const centerX = preview.cylinderCenter[planeAxes[0]];
  const centerY = preview.cylinderCenter[planeAxes[1]];
  const shape = new Shape();
  shape.moveTo(-halfWidth, -halfHeight);
  shape.lineTo(halfWidth, -halfHeight);
  shape.lineTo(halfWidth, halfHeight);
  shape.lineTo(-halfWidth, halfHeight);
  shape.lineTo(-halfWidth, -halfHeight);

  const hole = new Path();
  hole.absarc(centerX, centerY, radius, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 64,
    depth,
  });
  geometry.translate(0, 0, -depth / 2);
  if (axisIndex !== 2) {
    remapExtrudedCardinalAxisGeometry(geometry, axisIndex);
  }
  return geometry;
}

function cardinalAxisIndex(axis: readonly [number, number, number]): 0 | 1 | 2 | null {
  const abs = axis.map((value) => Math.abs(value)) as [number, number, number];
  const max = Math.max(...abs);
  if (max <= 1e-12) return null;
  const index = abs.indexOf(max) as 0 | 1 | 2;
  for (let entryIndex = 0; entryIndex < abs.length; entryIndex += 1) {
    if (entryIndex !== index && abs[entryIndex] / max > 1e-9) {
      return null;
    }
  }
  return index;
}

function planeAxesForCardinalAxis(axisIndex: 0 | 1 | 2): [0 | 1 | 2, 0 | 1 | 2] {
  if (axisIndex === 0) return [1, 2];
  if (axisIndex === 1) return [0, 2];
  return [0, 1];
}

function remapExtrudedCardinalAxisGeometry(
  geometry: BufferGeometry,
  axisIndex: 0 | 1,
): void {
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  if (!position) return;

  for (let index = 0; index < position.count; index += 1) {
    const localX = position.getX(index);
    const localY = position.getY(index);
    const localZ = position.getZ(index);
    if (axisIndex === 0) {
      position.setXYZ(index, localZ, localX, localY);
    } else {
      position.setXYZ(index, localX, localZ, localY);
    }
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function shouldRenderPrimitiveObject(
  object: Viewport3DPrimitiveObject,
  settings: VisualizationTargetSettings,
): boolean {
  return (
    object.meshState !== "mesh-ready" &&
    settings.visible &&
    settings.primitiveVisible === true
  );
}

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector3,
} from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { resolvePrimitiveSurfaceColor } from "@/kernel/visualization/primitiveSurfaceColor";
import type { PrimitiveDraft } from "@/kernel/authoring/geometryLifecycleCommands";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  cardinalAxisIndex,
  planeAxesForCardinalAxis,
  type Viewport3DBoxCylinderDifferencePreview,
  type Viewport3DCylinderCylinderDifferencePreview,
  type Viewport3DPrimitiveObject,
} from "../viewport3dPrimitiveModel";

export function primitiveDraftOverlayObject(
  draft: PrimitiveDraft,
): Viewport3DPrimitiveObject | null {
  if (!draft.dimensions || !draft.translation || Object.keys(draft.errors).length > 0) {
    return null;
  }
  const dimensions = draft.dimensions;
  const translation = draft.translation;
  const kind = draft.kind.toLowerCase() as "box" | "cylinder" | "sphere";
  const axisSuffix = draft.cylinder ? `:${draft.cylinder.axis.join(",")}` : "";
  return {
    bounds: {
      center: translation,
      radius: Math.hypot(...dimensions) / 2,
      size: dimensions,
    },
    csgPreview: null,
    ...(draft.cylinder
      ? {
          cylinderParams: {
            axis: [...draft.cylinder.axis] as [number, number, number],
            height: draft.cylinder.height,
            radius: draft.cylinder.radius,
          },
        }
      : {}),
    fallbackLabel: "draft preview",
    geometryKey: `draft:${draft.kind}:${dimensions.join(",")}:${translation.join(",")}${axisSuffix}`,
    kind,
    label: `New ${kind}`,
    magnetizationTexturePreview: null,
    meshState: "primitive-only",
    objectId: "draft:primitive",
    sceneRevision: -1,
  };
}

export interface PrimitiveGroupTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

/**
 * Resolves the Three.js `<group>` pose for a primitive object following the
 * canonical column-vector transform `M = T(t + p) R S T(-p)`.
 */
export function resolvePrimitiveGroupTransform(
  object: Viewport3DPrimitiveObject,
): PrimitiveGroupTransform {
  const tx = object.transform;
  if (!tx) {
    return {
      position: object.bounds.center,
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
  }

  const quat = new Quaternion();
  if (tx.rotationQuat) {
    quat.set(
      tx.rotationQuat[0],
      tx.rotationQuat[1],
      tx.rotationQuat[2],
      tx.rotationQuat[3],
    );
    if (quat.lengthSq() > 1e-24) {
      quat.normalize();
    } else {
      quat.identity();
    }
  } else if (tx.rotation) {
    quat.setFromEuler(
      new Euler(tx.rotation[0], tx.rotation[1], tx.rotation[2], "XYZ"),
    );
  }

  const scale: [number, number, number] = tx.scale
    ? [tx.scale[0], tx.scale[1], tx.scale[2]]
    : [1, 1, 1];
  const pivot: [number, number, number] = tx.pivot
    ? [tx.pivot[0], tx.pivot[1], tx.pivot[2]]
    : [0, 0, 0];
  const hasPivot =
    Math.abs(pivot[0]) > 1e-15 ||
    Math.abs(pivot[1]) > 1e-15 ||
    Math.abs(pivot[2]) > 1e-15;
  const baseTranslation = tx.translation;

  const position: [number, number, number] = hasPivot
    ? (() => {
        const rotatedScaledPivot = new Vector3(
          pivot[0] * scale[0],
          pivot[1] * scale[1],
          pivot[2] * scale[2],
        ).applyQuaternion(quat);
        return [
          baseTranslation[0] + pivot[0] - rotatedScaledPivot.x,
          baseTranslation[1] + pivot[1] - rotatedScaledPivot.y,
          baseTranslation[2] + pivot[2] - rotatedScaledPivot.z,
        ];
      })()
    : [baseTranslation[0], baseTranslation[1], baseTranslation[2]];

  return {
    position,
    quaternion: [quat.x, quat.y, quat.z, quat.w],
    scale,
  };
}

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
  _settings: VisualizationTargetSettings,
): boolean {
  // Wireframe is a display pass, not an implicit manipulate mode.  The
  // texture-pivot marker has no user-facing mode/command yet, so rendering it
  // here makes ordinary Shaded + Wireframe show a misleading red sphere.
  return false;
}

/**
 * A primitive-only carrier has no field-capable mesh surface. When the user
 * requests the shaded pass, represent that pass with the field-free primitive
 * preview instead of returning an empty group. Mesh-backed objects continue to
 * use their real topology layers and are not changed by this fallback.
 */
export function resolvePrimitiveObjectRenderSettings(
  object: Viewport3DPrimitiveObject,
  settings: VisualizationTargetSettings,
  allowMeshReadyPreview = false,
): VisualizationTargetSettings {
  if (
    (object.meshState === "mesh-ready" && !allowMeshReadyPreview) ||
    settings.primitiveVisible ||
    !settings.shaderVisible
  ) {
    return settings;
  }
  return {
    ...settings,
    primitiveVisible: true,
  };
}

export function createPrimitiveObjectGeometry(
  object: Viewport3DPrimitiveObject,
): BufferGeometry {
  if (object.kind === "imported-surface") {
    if (!object.importedSurface) throw new Error("Imported geometry requires its source triangles.");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(
      object.importedSurface.positions, (value, index) => value - object.importedSurface!.bounds.center[index % 3],
    ), 3));
    geometry.setIndex(new BufferAttribute(object.importedSurface.triangles, 1));
    geometry.computeVertexNormals();
    return geometry;
  }
  if (object.kind === "microstrip" || object.kind === "cpw") {
    if (!object.antennaPreview) throw new Error("Antenna layout requires an authored section preview.");
    const preview = object.antennaPreview;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(
      preview.positions, (value, index) => value - object.bounds.center[index % 3],
    ), 3));
    geometry.setIndex(preview.indices);
    geometry.setAttribute("uv", new BufferAttribute(Float32Array.from(
      preview.positions.flatMap((_, index) => {
        if (index % 3 !== 0) return [];
        return [
          (preview.positions[index] - object.bounds.center[0]) / Math.max(object.bounds.size[0], 1e-12),
          ((preview.positions[index + 1] - object.bounds.center[1]) +
            (preview.positions[index + 2] - object.bounds.center[2])) /
            Math.max(object.bounds.size[1] + object.bounds.size[2], 1e-12),
        ];
      }),
    ), 2));
    geometry.userData.conductorParts = preview.parts;
    geometry.computeVertexNormals();
    return geometry;
  }
  if (
    object.kind === "box-cylinder-difference" &&
    object.csgPreview?.kind === "box-cylinder-difference"
  ) {
    return createBoxCylinderDifferenceGeometry(object.csgPreview);
  }
  if (
    object.kind === "cylinder-cylinder-difference" &&
    object.csgPreview?.kind === "cylinder-cylinder-difference"
  ) {
    return createCylinderCylinderDifferenceGeometry(object.csgPreview);
  }

  const [x, y, z] = object.localSize ?? object.bounds.size;
  if (object.kind === "sphere") {
    return new SphereGeometry(Math.max(x, y, z) / 2, 32, 16);
  }
  if (object.kind === "cylinder") {
    const radius = object.cylinderParams?.radius ?? Math.min(x, y) / 2;
    const height = object.cylinderParams?.height ?? z;
    const rawAxis = object.cylinderParams?.axis ?? [0, 0, 1];
    const axis = new Vector3(rawAxis[0], rawAxis[1], rawAxis[2]);
    if (axis.lengthSq() > 1e-24) {
      axis.normalize();
    } else {
      axis.set(0, 0, 1);
    }
    const geometry = new CylinderGeometry(radius, radius, height, 32, 1);
    const up = new Vector3(0, 1, 0);
    const orientation = new Quaternion();
    if (axis.dot(up) < -0.999999) {
      orientation.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
    } else {
      orientation.setFromUnitVectors(up, axis);
    }
    geometry.applyQuaternion(orientation);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
  return new BoxGeometry(x, y, z);
}

/** Presentation only: a literal user override precedes the authored antenna role default. */
export function primitiveObjectSurfaceColor(
  object: Pick<Viewport3DPrimitiveObject, "role"> &
    Partial<Pick<Viewport3DPrimitiveObject, "objectId">>,
  settings: VisualizationTargetSettings,
  colors: Viewport3DColors,
  assignments?: ReadonlyMap<string, number>,
) {
  const resolved = resolvePrimitiveSurfaceColor(
    object.role,
    settings,
    object.objectId,
    assignments,
  );
  if (resolved.paletteIndex !== undefined) {
    return colors.primitivePalette?.[resolved.paletteIndex] ?? colors.accent;
  }
  if (resolved.source === "antenna-theme") return colors.antenna ?? colors.mesh;
  if (resolved.source === "magnetic-theme") return colors.accent;
  if (resolved.source === "object-theme") return colors.mesh;
  return resolved.color;
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

function createCylinderCylinderDifferenceGeometry(
  preview: Viewport3DCylinderCylinderDifferencePreview,
): BufferGeometry {
  const axisIndex = cardinalAxisIndex(preview.cylinderAxis);
  if (axisIndex === null) {
    const [x, y, z] = preview.boundsSize;
    return new BoxGeometry(x, y, z);
  }

  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  const innerCenterX =
    preview.innerCenter[planeAxes[0]] - preview.outerCenter[planeAxes[0]];
  const innerCenterY =
    preview.innerCenter[planeAxes[1]] - preview.outerCenter[planeAxes[1]];
  const shape = new Shape();
  shape.absarc(0, 0, preview.outerRadius, 0, Math.PI * 2, false);
  const hole = new Path();
  hole.absarc(
    innerCenterX,
    innerCenterY,
    preview.innerRadius,
    0,
    Math.PI * 2,
    true,
  );
  shape.holes.push(hole);

  const geometry = new ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 64,
    depth: preview.outerHeight,
  });
  geometry.translate(0, 0, -preview.outerHeight / 2);
  if (axisIndex !== 2) {
    remapExtrudedCardinalAxisGeometry(geometry, axisIndex);
  }
  return geometry;
}

function remapExtrudedCardinalAxisGeometry(
  geometry: BufferGeometry,
  axisIndex: 0 | 1,
): void {
  // Rotate normals together with positions. Both maps preserve handedness;
  // swapping only Y/Z would invert the winding of an extrusion along Y.
  const rotation = axisIndex === 0
    ? new Matrix4().set(
        0, 0, 1, 0,
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
      )
    : new Matrix4().set(
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
      );
  geometry.applyMatrix4(rotation);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function shouldRenderPrimitiveObject(
  object: Viewport3DPrimitiveObject,
  settings: VisualizationTargetSettings,
  hasRealizedObjectGeometry = false,
  allowMeshReadyPreview = false,
): boolean {
  const renderSettings = resolvePrimitiveObjectRenderSettings(
    object,
    settings,
    allowMeshReadyPreview,
  );
  return (
    !hasRealizedObjectGeometry &&
    (object.meshState !== "mesh-ready" || allowMeshReadyPreview) &&
    renderSettings.visible &&
    (renderSettings.primitiveVisible === true ||
      renderSettings.shaderVisible ||
      renderSettings.pointsVisible ||
      renderSettings.wireframeVisible ||
      renderSettings.boundsVisible)
  );
}

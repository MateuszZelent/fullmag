import type { TextureTransform3D as PreviewTextureTransform3D } from "@/lib/textureTransform";
import {
  applyAffineTransformToPoint,
  applyLinearTransformToPoint,
  quatInverse,
  quatMultiply,
  removeAffineTransformFromPoint,
  removeLinearTransformFromPoint,
  scaleVec3Components,
  type Quat,
  type Vec3,
} from "@/lib/textureTransformMath";
import type { TextureTransform3D as SceneTextureTransform3D } from "../../../lib/session/types";

export type { Quat, Vec3 } from "@/lib/textureTransformMath";

export function domainFrameSourceLabel(source: string | null): string {
  switch (source) {
    case "declared_universe_manual":
      return "Declared Universe";
    case "declared_universe_auto_padding":
      return "Auto-Padded Domain";
    case "object_union_bounds":
      return "Object Union Bounds";
    case "mesh_bounds":
      return "Mesh Bounds";
    default:
      return "Workspace Frame";
  }
}

export function visibleVolumeLabel(
  isFemBackend: boolean,
  clipEnabled: boolean,
  clipAxis: "x" | "y" | "z",
  clipPos: number,
): string {
  if (!isFemBackend) {
    return "Full Domain";
  }
  if (!clipEnabled) {
    return "Full Effective Domain";
  }
  return `Clipped ${clipAxis.toUpperCase()} @${Math.round(clipPos)}%`;
}

export function toPreviewTextureTransform(value: SceneTextureTransform3D): PreviewTextureTransform3D {
  return {
    translation: [...value.translation] as [number, number, number],
    rotation_quat: [...value.rotation_quat] as [number, number, number, number],
    scale: [...value.scale] as [number, number, number],
    pivot: [...value.pivot] as [number, number, number],
  };
}

export function toSceneTextureTransform(value: PreviewTextureTransform3D): SceneTextureTransform3D {
  return {
    translation: [...value.translation] as [number, number, number],
    rotation_quat: [...value.rotation_quat] as [number, number, number, number],
    scale: [...value.scale] as [number, number, number],
    pivot: [...value.pivot] as [number, number, number],
  };
}

export function offsetTextureTransform(
  value: PreviewTextureTransform3D,
  offset: [number, number, number],
): PreviewTextureTransform3D {
  return {
    translation: [
      value.translation[0] + offset[0],
      value.translation[1] + offset[1],
      value.translation[2] + offset[2],
    ],
    rotation_quat: [...value.rotation_quat] as [number, number, number, number],
    scale: [...value.scale] as [number, number, number],
    pivot: [
      value.pivot[0] + offset[0],
      value.pivot[1] + offset[1],
      value.pivot[2] + offset[2],
    ],
  };
}

export function textureTransformToWorld(
  tex: PreviewTextureTransform3D,
  objTransform: { translation: Vec3; rotation_quat: Quat; scale: Vec3 },
): PreviewTextureTransform3D {
  const worldQuat = quatMultiply(objTransform.rotation_quat, tex.rotation_quat);
  const worldScale = scaleVec3Components(objTransform.scale, tex.scale);
  return {
    translation: applyAffineTransformToPoint(tex.translation, objTransform),
    rotation_quat: worldQuat,
    scale: worldScale,
    pivot: applyLinearTransformToPoint(tex.pivot, objTransform),
  };
}

export function textureTransformToLocal(
  tex: PreviewTextureTransform3D,
  objTransform: { translation: Vec3; rotation_quat: Quat; scale: Vec3 },
): PreviewTextureTransform3D {
  const invR = quatInverse(objTransform.rotation_quat);
  const localQuat = quatMultiply(invR, tex.rotation_quat);
  const localScale = scaleVec3Components(tex.scale, [
    objTransform.scale[0] !== 0 ? 1 / objTransform.scale[0] : 0,
    objTransform.scale[1] !== 0 ? 1 / objTransform.scale[1] : 0,
    objTransform.scale[2] !== 0 ? 1 / objTransform.scale[2] : 0,
  ]);
  return {
    translation: removeAffineTransformFromPoint(tex.translation, objTransform),
    rotation_quat: localQuat,
    scale: localScale,
    pivot: removeLinearTransformFromPoint(tex.pivot, objTransform),
  };
}

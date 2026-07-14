import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";

import {
  canonicalVisualizationSceneObjectId,
  type VisualizationMeshPartLike,
  visualizationObjectIdForMeshPartLike,
} from "./selectionTypes";

export function resolveVisualizationTargetForMeshPart({
  part,
  sceneObjectIds,
  targetRegistry,
}: {
  part: VisualizationMeshPartLike;
  sceneObjectIds: ReadonlySet<string>;
  targetRegistry: VisualizationStateResource["targets"] | null | undefined;
}): VisualizationTargetRef {
  if (part.role === "air" || part.role === "airbox") {
    return { id: "airbox", kind: "airbox", label: "Airbox" };
  }

  if (
    targetRegistry?.parts.some(
      (target) => target.scope === "part" && target.scope_id === part.id,
    )
  ) {
    return partTarget(part);
  }

  const objectId = visualizationObjectIdForMeshPartLike({
    object_id: part.object_id,
  });
  if (objectId && sceneObjectIds.has(objectId)) {
    return objectTarget(objectId, part.label);
  }

  const geometryId = part.geometry_id
    ? canonicalVisualizationSceneObjectId(part.geometry_id)
    : null;
  if (geometryId && sceneObjectIds.has(geometryId)) {
    return objectTarget(geometryId, part.label);
  }

  return partTarget(part);
}

export function visualizationSceneObjectIds(scene: unknown): ReadonlySet<string> {
  const sceneRecord = asRecord(scene);
  const objects = Array.isArray(sceneRecord?.objects) ? sceneRecord.objects : [];
  const ids = new Set<string>();

  for (const value of objects) {
    const object = asRecord(value);
    const id = typeof object?.id === "string" ? object.id.trim() : "";
    if (id) ids.add(canonicalVisualizationSceneObjectId(id));
  }

  return ids;
}

function objectTarget(
  objectId: string,
  label: string | null | undefined,
): VisualizationTargetRef {
  return {
    id: `object:${objectId}`,
    kind: "object",
    label,
  };
}

function partTarget(part: VisualizationMeshPartLike): VisualizationTargetRef {
  return {
    id: part.id,
    kind: "part",
    label: part.label,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

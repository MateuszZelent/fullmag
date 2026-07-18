import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

export type MeshPartSurfaceGeometryProjection =
  | "indexed"
  | VisualizationTargetSettings["surfaceProjectionMode"];

export function resolveMeshPartSurfaceGeometryProjection(
  settings: Pick<
    VisualizationTargetSettings,
    "surfaceColorSource" | "surfaceProjectionMode"
  >,
): MeshPartSurfaceGeometryProjection {
  return settings.surfaceProjectionMode !== "raw_nodal" &&
    settings.surfaceColorSource !== "solid"
    ? settings.surfaceProjectionMode
    : "indexed";
}

export function buildMeshPartSurfaceGeometryUploadKey({
  indicesByteLength,
  partId,
  positionsByteLength,
  projection,
  topologyRevision,
}: {
  indicesByteLength: number;
  partId: string;
  positionsByteLength: number;
  projection: MeshPartSurfaceGeometryProjection;
  topologyRevision: number | string | null;
}): string {
  return `mesh-part-surface:${partId}:projection=${projection}:topology=${topologyRevision ?? "none"}:positions=${positionsByteLength}:indices=${indicesByteLength}`;
}

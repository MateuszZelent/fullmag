import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import type { Viewport3DBounds } from "../viewport3dRenderModel";

export const FULL_FIELD_QUERY: FieldVectorQuery = {
  component: "full",
  scope_kind: "full",
};

export function targetForFdmDomain(
  domainId: string | null | undefined,
): VisualizationTargetRef | null {
  if (!domainId) return null;
  return {
    id: domainId,
    kind: "object",
    label: domainId,
  };
}

export function targetForMeshPart(
  part: Viewport3DMeshPart,
): VisualizationTargetRef {
  if (part.object_id) {
    return {
      id: part.object_id,
      kind: "object",
      label: part.label,
    };
  }

  return {
    id: part.id,
    kind: "part",
    label: part.label,
  };
}

export function resolveViewport3DSelectionBounds(
  selection: Selection,
  domain: FemManifestRenderDomain,
  fallbackBounds: Viewport3DBounds | null,
): Viewport3DBounds | null {
  if (!selection.kind) return null;

  return (
    resolveMeshQualityElementBounds(selection, fallbackBounds) ??
    resolveMeshPartBounds(
      selection.nodeId ? domain.partsById.get(selection.nodeId) : null,
    ) ??
    resolveObjectBounds(domain, selection.objectId) ??
    (selection.kind === "airbox.visualization" ||
    selection.kind === "mesh-part-airbox"
      ? resolveAirboxBounds(domain)
      : fallbackBounds)
  );
}

function resolveMeshQualityElementBounds(
  selection: Selection,
  fallbackBounds: Viewport3DBounds | null,
): Viewport3DBounds | null {
  if (selection.ref?.type !== "mesh-quality-element" || !selection.ref.centroid) {
    return null;
  }
  const radius = Math.max((fallbackBounds?.radius ?? 1e-9) * 0.03, 1e-12);
  const size = radius * 2;
  return {
    center: selection.ref.centroid,
    radius,
    size: [size, size, size],
  };
}

function resolveAirboxBounds(
  domain: FemManifestRenderDomain,
): Viewport3DBounds | null {
  return combineBounds(domain.airboxParts.map(resolveMeshPartBounds));
}

function resolveObjectBounds(
  domain: FemManifestRenderDomain,
  objectId: string | null,
): Viewport3DBounds | null {
  if (!objectId) return null;
  let partIds = domain.objectPartIds.get(objectId);
  if (!partIds) {
    partIds = domain.objectPartIds.get(`${objectId}_geom`);
  }
  if (!partIds && objectId.endsWith("_geom")) {
    partIds = domain.objectPartIds.get(objectId.slice(0, -5));
  }
  const ids = partIds ?? [];
  return combineBounds(
    ids.map((partId) => resolveMeshPartBounds(domain.partsById.get(partId))),
  );
}

function combineBounds(
  boundsList: Array<Viewport3DBounds | null>,
): Viewport3DBounds | null {
  const validBounds = boundsList.filter(
    (entry): entry is Viewport3DBounds => Boolean(entry),
  );
  if (!validBounds.length) return null;

  const min = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.min(current[0], bounds.center[0] - bounds.size[0] / 2),
      Math.min(current[1], bounds.center[1] - bounds.size[1] / 2),
      Math.min(current[2], bounds.center[2] - bounds.size[2] / 2),
    ],
    [Infinity, Infinity, Infinity],
  );
  const max = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.max(current[0], bounds.center[0] + bounds.size[0] / 2),
      Math.max(current[1], bounds.center[1] + bounds.size[1] / 2),
      Math.max(current[2], bounds.center[2] + bounds.size[2] / 2),
    ],
    [-Infinity, -Infinity, -Infinity],
  );
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

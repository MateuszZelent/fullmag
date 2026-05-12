import type {
  DomainMetaResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";

import {
  resolveDomainBounds,
  type Viewport3DBounds,
  type Viewport3DNodeSelection,
} from "./viewport3dRenderModel";

type MeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

export type Viewport3DMeshPart = MeshPart;

export interface FdmGridRenderDomain {
  bounds: Viewport3DBounds | null;
  displayCellBudget: number;
  displayCellCount: number;
  kind: "fdm-grid";
  origin: [number, number, number];
  shape: [number, number, number];
  spacing: [number, number, number];
  stride: number;
  totalCells: number;
}

export interface FemManifestRenderDomain {
  airboxParts: MeshPart[];
  magneticParts: MeshPart[];
  objectPartIds: Map<string, string[]>;
  partsById: Map<string, MeshPart>;
}

export interface Viewport3DPartSelection {
  kind: "mesh-part" | "mesh-part-airbox";
  label: string;
  nodeId: string;
  objectId: string | null;
  part: MeshPart;
}

export function adaptFdmDomainMeta(
  meta: DomainMetaResource | null | undefined,
  displayCellBudget: number,
): FdmGridRenderDomain | null {
  if (!meta || meta.discretization !== "fdm" || !meta.grid) {
    return null;
  }

  const shape: [number, number, number] = [
    Math.max(meta.grid.shape[0] ?? 1, 1),
    Math.max(meta.grid.shape[1] ?? 1, 1),
    Math.max(meta.grid.shape[2] ?? 1, 1),
  ];
  const bounds = resolveDomainBounds(meta);
  const fallbackSize = bounds?.size ?? [1, 1, 1];
  const fallbackOrigin: [number, number, number] = bounds
    ? [
        bounds.center[0] - fallbackSize[0] / 2,
        bounds.center[1] - fallbackSize[1] / 2,
        bounds.center[2] - fallbackSize[2] / 2,
      ]
    : [0, 0, 0];
  const origin: [number, number, number] = [
    meta.grid.origin[0] ?? fallbackOrigin[0],
    meta.grid.origin[1] ?? fallbackOrigin[1],
    meta.grid.origin[2] ?? fallbackOrigin[2],
  ];
  const spacing: [number, number, number] = [
    Math.max(meta.grid.spacing[0] ?? fallbackSize[0] / shape[0], 1e-18),
    Math.max(meta.grid.spacing[1] ?? fallbackSize[1] / shape[1], 1e-18),
    Math.max(meta.grid.spacing[2] ?? fallbackSize[2] / shape[2], 1e-18),
  ];
  const totalCells = Math.max(
    meta.counts.cells ?? shape[0] * shape[1] * shape[2],
    0,
  );
  const safeBudget = Math.max(Math.floor(displayCellBudget), 1);
  const displayCellCount = totalCells === 0 ? 0 : Math.min(totalCells, safeBudget);

  return {
    bounds,
    displayCellBudget: safeBudget,
    displayCellCount,
    kind: "fdm-grid",
    origin,
    shape,
    spacing,
    stride:
      displayCellCount === 0
        ? 1
        : Math.max(1, Math.ceil(totalCells / displayCellCount)),
    totalCells,
  };
}

export function adaptFemSharedDomainManifest(
  manifest: MeshSharedDomainManifestResource | null | undefined,
): FemManifestRenderDomain {
  const parts = manifest?.mesh_parts ?? [];
  const objectPartIds = new Map<string, string[]>();
  const partsById = new Map<string, MeshPart>();
  const airboxParts: MeshPart[] = [];
  const magneticParts: MeshPart[] = [];

  for (const part of parts) {
    partsById.set(part.id, part);
    if (part.role === "air") {
      airboxParts.push(part);
    } else {
      magneticParts.push(part);
    }

    if (part.object_id) {
      const ids = objectPartIds.get(part.object_id) ?? [];
      ids.push(part.id);
      objectPartIds.set(part.object_id, ids);
    }
  }

  return {
    airboxParts,
    magneticParts,
    objectPartIds,
    partsById,
  };
}

export function resolveFemPartSelectionByBoundaryFace(
  domain: FemManifestRenderDomain,
  faceIndex: number | null | undefined,
): Viewport3DPartSelection | null {
  if (faceIndex === null || faceIndex === undefined || faceIndex < 0) {
    return null;
  }

  for (const part of domain.partsById.values()) {
    if (partIncludesBoundaryFace(part, faceIndex)) {
      return selectionForMeshPart(part);
    }
  }

  return null;
}

export function selectionForMeshPart(part: MeshPart): Viewport3DPartSelection {
  return {
    kind: part.role === "air" ? "mesh-part-airbox" : "mesh-part",
    label: part.label,
    nodeId: part.id,
    objectId: part.object_id ?? null,
    part,
  };
}

export function resolveMeshPartBounds(
  part: MeshPart | null | undefined,
): Viewport3DBounds | null {
  const min = part?.bounds_min;
  const max = part?.bounds_max;
  if (!min || !max || min.length < 3 || max.length < 3) {
    return null;
  }

  const size: [number, number, number] = [
    Math.max((max[0] ?? 0) - (min[0] ?? 0), 0),
    Math.max((max[1] ?? 0) - (min[1] ?? 0), 0),
    Math.max((max[2] ?? 0) - (min[2] ?? 0), 0),
  ];

  return {
    center: [
      (min[0] ?? 0) + size[0] / 2,
      (min[1] ?? 0) + size[1] / 2,
      (min[2] ?? 0) + size[2] / 2,
    ],
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

export function resolveMeshPartNodeSelection(
  part: MeshPart,
): Viewport3DNodeSelection {
  return {
    nodeCount: part.node_count,
    nodeIndices: part.node_indices,
    nodeStart: part.node_start,
  };
}

function partIncludesBoundaryFace(part: MeshPart, faceIndex: number): boolean {
  if (part.boundary_face_indices?.includes(faceIndex)) {
    return true;
  }

  return (
    faceIndex >= part.boundary_face_start &&
    faceIndex < part.boundary_face_start + part.boundary_face_count
  );
}

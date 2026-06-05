import type {
  DomainMetaResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";

import {
  resolveDomainBounds,
  type Viewport3DBounds,
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
  magneticSurfacePartsByPartId: Map<string, MeshPart[]>;
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
  const interfaceParts: MeshPart[] = [];
  const magneticPartIdsByAlias = new Map<string, Set<string>>();
  const magneticSurfacePartsByPartId = new Map<string, MeshPart[]>();

  for (const part of parts) {
    partsById.set(part.id, part);
    if (part.role === "air") {
      airboxParts.push(part);
    } else if (isMagneticRenderablePart(part)) {
      magneticParts.push(part);
      addMagneticPartAliases(magneticPartIdsByAlias, part);
    } else if (isInterfaceSurfacePart(part)) {
      interfaceParts.push(part);
    }

    addObjectPartAlias(objectPartIds, part.object_id, part.id);
    addObjectPartAlias(objectPartIds, part.geometry_id, part.id);
  }

  for (const part of interfaceParts) {
    const owningPartId = resolveMagneticInterfaceOwnerPartId(
      part,
      magneticPartIdsByAlias,
    );
    if (!owningPartId) continue;
    const target = magneticSurfacePartsByPartId.get(owningPartId) ?? [];
    target.push(part);
    magneticSurfacePartsByPartId.set(owningPartId, target);
  }

  return {
    airboxParts,
    magneticParts,
    magneticSurfacePartsByPartId,
    objectPartIds,
    partsById,
  };
}

function addObjectPartAlias(
  objectPartIds: Map<string, string[]>,
  objectId: string | null | undefined,
  partId: string,
): void {
  if (!objectId) return;
  addObjectPartId(objectPartIds, objectId, partId);
  if (objectId.endsWith("_geom")) {
    addObjectPartId(objectPartIds, objectId.slice(0, -5), partId);
  } else {
    addObjectPartId(objectPartIds, `${objectId}_geom`, partId);
  }
}

function addObjectPartId(
  objectPartIds: Map<string, string[]>,
  objectId: string,
  partId: string,
): void {
  const ids = objectPartIds.get(objectId) ?? [];
  if (!ids.includes(partId)) {
    ids.push(partId);
  }
  objectPartIds.set(objectId, ids);
}

function isMagneticRenderablePart(part: MeshPart): boolean {
  return Boolean(
    part.object_id ||
      part.role === "magnetic" ||
      part.role === "magnetic_object",
  );
}

function isInterfaceSurfacePart(part: MeshPart): boolean {
  return Boolean(
    part.role === "interface" &&
      ((part.surface_faces?.length ?? 0) > 0 ||
        (part.boundary_face_indices?.length ?? 0) > 0 ||
        part.boundary_face_count > 0),
  );
}

function addMagneticPartAliases(
  index: Map<string, Set<string>>,
  part: MeshPart,
): void {
  addMagneticPartAlias(index, part.object_id, part.id);
  addMagneticPartAlias(index, part.geometry_id, part.id);
  addMagneticPartAlias(index, part.label, part.id);
  addMagneticPartAlias(index, part.id, part.id);
  if (part.id.startsWith("part:")) {
    addMagneticPartAlias(index, part.id.slice("part:".length), part.id);
  }
}

function addMagneticPartAlias(
  index: Map<string, Set<string>>,
  value: string | null | undefined,
  partId: string,
): void {
  const alias = normalizeMeshPartAlias(value);
  if (!alias) return;
  const ids = index.get(alias) ?? new Set<string>();
  ids.add(partId);
  index.set(alias, ids);
}

function resolveMagneticInterfaceOwnerPartId(
  part: MeshPart,
  magneticPartIdsByAlias: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const direct =
    resolveSingleMagneticPartAlias(part.object_id, magneticPartIdsByAlias) ??
    resolveSingleMagneticPartAlias(part.geometry_id, magneticPartIdsByAlias);
  if (direct) return direct;

  const labelOwner = resolveMagneticInterfaceOwnerAlias(part.label);
  return resolveSingleMagneticPartAlias(labelOwner, magneticPartIdsByAlias);
}

function resolveSingleMagneticPartAlias(
  value: string | null | undefined,
  index: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const alias = normalizeMeshPartAlias(value);
  if (!alias) return null;
  const ids = index.get(alias);
  if (!ids || ids.size !== 1) return null;
  return ids.values().next().value ?? null;
}

function resolveMagneticInterfaceOwnerAlias(label: string | null | undefined): string | null {
  if (!label) return null;
  const sides = label
    .split("↔")
    .map((side) => side.trim())
    .filter(Boolean);
  if (sides.length !== 2) return null;

  const magneticSides = sides.filter((side) => normalizeMeshPartAlias(side) !== "air");
  return magneticSides.length === 1 ? magneticSides[0] ?? null : null;
}

function normalizeMeshPartAlias(value: string | null | undefined): string | null {
  const alias = value?.trim().toLowerCase();
  if (!alias) return null;
  return alias.endsWith("_geom") ? alias.slice(0, -"_geom".length) : alias;
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

function partIncludesBoundaryFace(part: MeshPart, faceIndex: number): boolean {
  if (part.boundary_face_indices?.includes(faceIndex)) {
    return true;
  }

  return (
    faceIndex >= part.boundary_face_start &&
    faceIndex < part.boundary_face_start + part.boundary_face_count
  );
}

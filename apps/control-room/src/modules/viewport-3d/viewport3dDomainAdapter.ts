import type {
  DomainMetaResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import { visualizationObjectIdForMeshPartLike } from "@/kernel/selection/selectionTypes";
import {
  resolveManifestRenderableCarrierKind,
  type ManifestRenderableCarrierKind,
} from "@/kernel/visualization/visualizationDisplayResolution";

import {
  resolveDomainBounds,
  type Viewport3DBounds,
} from "./viewport3dRenderModel";

type MeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

type ObjectSegment = NonNullable<
  MeshSharedDomainManifestResource["object_segments"]
>[number];

export type ManifestRenderableCarrierSourceKind =
  | "mesh-part"
  | "object-segment";

export type Viewport3DMeshPart =
  | (MeshPart & {
      carrierKind?: ManifestRenderableCarrierSourceKind;
      fieldCapable?: boolean;
    })
  | Viewport3DObjectSegmentCarrier;

export type Viewport3DObjectSegmentCarrier =
  Omit<MeshPart, "geometry_id" | "object_id"> &
  ObjectSegment & {
    carrierKind: "object-segment";
    fieldCapable: false;
    id: string;
    label: string;
    role: "magnetic";
  };

export type Viewport3DManifestRenderableCarrier =
  | Viewport3DMeshPart
  | Viewport3DObjectSegmentCarrier;

export interface ManifestRenderableCarrierDiagnostics {
  degradedCarrierCount: number;
  kind: ManifestRenderableCarrierKind;
  renderableCarrierCount: number;
}

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
  airboxParts: Viewport3DMeshPart[];
  fieldCapableAirboxParts?: Viewport3DMeshPart[];
  fieldCapableMagneticParts?: Viewport3DMeshPart[];
  magneticParts: Viewport3DMeshPart[];
  magneticSurfacePartsByPartId: Map<string, Viewport3DMeshPart[]>;
  objectPartIds: Map<string, string[]>;
  partsById: Map<string, Viewport3DMeshPart>;
  renderCarrierDiagnostics?: ManifestRenderableCarrierDiagnostics;
}

export interface Viewport3DPartSelection {
  boundaryFaceIndex?: number | null;
  kind: "mesh-part" | "mesh-part-airbox";
  label: string;
  nodeId: string;
  objectId: string | null;
  part: Viewport3DMeshPart;
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
  const carriers = manifestRenderableCarriers(manifest);
  const objectPartIds = new Map<string, string[]>();
  const partsById = new Map<string, Viewport3DMeshPart>();
  const airboxParts: Viewport3DMeshPart[] = [];
  const magneticParts: Viewport3DMeshPart[] = [];
  const interfaceParts: Viewport3DMeshPart[] = [];
  const magneticPartIdsByAlias = new Map<string, Set<string>>();
  const magneticSurfacePartsByPartId = new Map<string, Viewport3DMeshPart[]>();

  for (const part of carriers) {
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
    fieldCapableAirboxParts: airboxParts.filter(isFieldCapableManifestRenderCarrier),
    fieldCapableMagneticParts: magneticParts.filter(
      isFieldCapableManifestRenderCarrier,
    ),
    magneticParts,
    magneticSurfacePartsByPartId,
    objectPartIds,
    partsById,
    renderCarrierDiagnostics: carriers.diagnostics,
  };
}

export function manifestRenderableCarriers(
  manifest: MeshSharedDomainManifestResource | null | undefined,
): Viewport3DManifestRenderableCarrier[] & {
  diagnostics: ManifestRenderableCarrierDiagnostics;
} {
  const meshParts = (manifest?.mesh_parts ?? []).map((part) => ({
    ...part,
    carrierKind: "mesh-part" as const,
    fieldCapable: true as const,
  }));
  const meshOwnership = new Set<string>();
  for (const part of meshParts) {
    addCarrierOwnershipAlias(meshOwnership, part.object_id);
    addCarrierOwnershipAlias(meshOwnership, part.geometry_id);
  }
  const segments = (manifest?.object_segments ?? []).flatMap((segment, index) =>
    carrierOwnershipAliases(segment).some((alias) => meshOwnership.has(alias))
      ? []
      : [objectSegmentCarrier(segment, index)],
  );
  const carriers = [...meshParts, ...segments] as Viewport3DManifestRenderableCarrier[] & {
    diagnostics: ManifestRenderableCarrierDiagnostics;
  };
  carriers.diagnostics = {
    degradedCarrierCount: segments.length,
    kind: resolveManifestRenderableCarrierKind({
      meshPartCount: meshParts.length,
      objectSegmentCount: segments.length,
    }),
    renderableCarrierCount: carriers.filter(
      (carrier) =>
        carrier.carrierKind === "object-segment" ||
        carrier.role === "air" ||
        isMagneticRenderablePart(carrier),
    ).length,
  };
  return carriers;
}

export function isFieldCapableManifestRenderCarrier(
  part: Viewport3DMeshPart,
): boolean {
  return part.fieldCapable !== false;
}

function objectSegmentCarrier(
  segment: ObjectSegment,
  index: number,
): Viewport3DObjectSegmentCarrier {
  return {
    ...segment,
    carrierKind: "object-segment",
    fieldCapable: false,
    id: `segment:${segment.object_id}:${index}`,
    label: segment.object_id,
    role: "magnetic",
  };
}

function carrierOwnershipAliases(
  carrier: Pick<ObjectSegment, "geometry_id" | "object_id">,
): string[] {
  const aliases = new Set<string>();
  addCarrierOwnershipAlias(aliases, carrier.object_id);
  addCarrierOwnershipAlias(aliases, carrier.geometry_id);
  return [...aliases];
}

function addCarrierOwnershipAlias(
  aliases: Set<string>,
  objectId: string | null | undefined,
): void {
  if (!objectId) return;
  aliases.add(objectId);
  if (objectId.endsWith("_geom")) {
    aliases.add(objectId.slice(0, -5));
  } else {
    aliases.add(`${objectId}_geom`);
  }
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

function isMagneticRenderablePart(part: Viewport3DMeshPart): boolean {
  return Boolean(
    part.object_id ||
      part.role === "magnetic" ||
      part.role === "magnetic_object",
  );
}

function isInterfaceSurfacePart(part: Viewport3DMeshPart): boolean {
  return Boolean(
    part.role === "interface" &&
      ((part.surface_faces?.length ?? 0) > 0 ||
        (part.boundary_face_indices?.length ?? 0) > 0 ||
        part.boundary_face_count > 0),
  );
}

function addMagneticPartAliases(
  index: Map<string, Set<string>>,
  part: Viewport3DMeshPart,
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
  part: Viewport3DMeshPart,
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
  const sides = label.split("↔").flatMap((side) => {
    const trimmed = side.trim();
    return trimmed ? [trimmed] : [];
  });
  if (sides.length !== 2) return null;

  const magneticSides = sides.flatMap((side) =>
    normalizeMeshPartAlias(side) !== "air" ? [side] : [],
  );
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
      return selectionForMeshPart(part, faceIndex);
    }
  }

  return null;
}

export function selectionForMeshPart(
  part: Viewport3DMeshPart,
  boundaryFaceIndex: number | null = null,
): Viewport3DPartSelection {
  const objectId = visualizationObjectIdForMeshPartLike(part);
  return {
    boundaryFaceIndex,
    kind: part.role === "air" ? "mesh-part-airbox" : "mesh-part",
    label: part.label,
    nodeId: part.id,
    objectId,
    part,
  };
}

export function resolveMeshPartBounds(
  part: Viewport3DMeshPart | null | undefined,
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

function partIncludesBoundaryFace(
  part: Viewport3DMeshPart,
  faceIndex: number,
): boolean {
  if (part.boundary_face_indices?.includes(faceIndex)) {
    return true;
  }

  return (
    faceIndex >= part.boundary_face_start &&
    faceIndex < part.boundary_face_start + part.boundary_face_count
  );
}

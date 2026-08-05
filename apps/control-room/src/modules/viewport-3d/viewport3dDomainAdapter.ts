import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFdmRegionMembership,
  DecodedTopology,
} from "@/kernel/api/codecs";
import {
  normalizeManifestRenderableCarriers,
  type ManifestCarrierSourceKind,
  type ManifestRenderableCarrierDiagnostics,
  type NormalizedManifestObjectSegmentCarrier,
  type NormalizedManifestRenderableCarrier,
} from "@/kernel/selection/manifestRenderableCarriers";
import {
  isVisualizationAirboxIdentity,
  type MeshElementFamily,
  visualizationObjectIdForMeshPartLike,
} from "@/kernel/selection/selectionTypes";

import {
  resolveDomainBounds,
  type Viewport3DBounds,
} from "./viewport3dRenderModel";
import {
  buildDomainPresentation,
  type DomainPresentation,
  type DomainResourceState,
  type FdmUniverseOutsideMagneticSupport,
} from "@/shared/domain/mesh/domainPresentation";
import { resolveFdmDisplaySampling } from "@/shared/domain/mesh/fdmDisplaySampling";

export {
  buildDomainPresentation,
  domainPresentationKey,
  isFdmDomain,
  isFemDomain,
  resolveFdmCellState,
} from "@/shared/domain/mesh/domainPresentation";
export type {
  DomainPresentation,
  FdmDomainPresentation,
  FemDomainPresentation,
} from "@/shared/domain/mesh/domainPresentation";

export interface Viewport3DDomainPresentationInput {
  domainMeta: DomainMetaResource | null | undefined;
  expectedFdmGridFingerprint?: string | null;
  fdmMembership?: FdmRegionMembershipResource | null;
  fdmMembershipStatus?: DomainResourceState;
  femManifest?: MeshSharedDomainManifestResource | null;
  femTopology?: DecodedTopology | null;
  femTopologyStatus?: DomainResourceState;
  universeOutsideMagneticSupport?: Omit<
    FdmUniverseOutsideMagneticSupport,
    "kind"
  > | null;
}

export function adaptDomainPresentation(
  input: Viewport3DDomainPresentationInput,
): DomainPresentation {
  return buildDomainPresentation(input);
}

export function resolveViewport3DFdmRealizedRegionIds(
  presentation: DomainPresentation | null,
  binary: DecodedFdmRegionMembership | null,
): Uint32Array | null | undefined {
  if (!presentation || presentation.discretization !== "fdm") return undefined;
  if (presentation.resourceStatus === "authoring-grid") return undefined;
  if (presentation.resourceStatus !== "realized" || !binary) return null;
  const grid = presentation.fdmGrid;
  if (
    binary.semanticStatus !== "canonical" ||
    binary.gridFingerprint !== grid.gridFingerprint ||
    binary.cellCount !== grid.totalCells ||
    binary.counts.some((count, axis) => count !== grid.shape[axis])
  ) {
    return null;
  }
  return binary.regionIds;
}

type MeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

export type ManifestRenderableCarrierSourceKind = ManifestCarrierSourceKind;

export type Viewport3DMeshPart =
  | (MeshPart & {
      carrierKind?: ManifestRenderableCarrierSourceKind;
      fieldCapable?: boolean;
    })
  | Viewport3DObjectSegmentCarrier;

export type Viewport3DObjectSegmentCarrier =
  NormalizedManifestObjectSegmentCarrier;

export type Viewport3DManifestRenderableCarrier =
  NormalizedManifestRenderableCarrier;

export type { ManifestRenderableCarrierDiagnostics };

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
  carrierPartId: string;
  elementFamily?: MeshElementFamily | null;
  globalCellOrdinal?: string | null;
  kind: "mesh-part" | "mesh-part-airbox";
  label: string;
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
  const shapeCellCount = shape[0] * shape[1] * shape[2];
  if (
    meta.counts.cells != null &&
    meta.counts.cells !== shapeCellCount
  ) {
    return null;
  }
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
  const sampling = resolveFdmDisplaySampling(shapeCellCount, displayCellBudget);

  return {
    bounds,
    displayCellBudget: sampling.budget,
    displayCellCount: sampling.displaySamples,
    kind: "fdm-grid",
    origin,
    shape,
    spacing,
    stride: sampling.stride,
    totalCells: sampling.total,
  };
}

export function adaptFdmDomainPresentation(
  presentation: DomainPresentation | null,
  displayCellBudget: number,
): FdmGridRenderDomain | null {
  if (
    !presentation ||
    presentation.discretization !== "fdm" ||
    !presentation.fdmGrid.descriptorCellCountCompatible
  ) {
    return null;
  }
  const grid = presentation.fdmGrid;
  const min = presentation.bounds.min;
  const max = presentation.bounds.max;
  const size: [number, number, number] = [
    Math.max((max[0] ?? 0) - (min[0] ?? 0), 0),
    Math.max((max[1] ?? 0) - (min[1] ?? 0), 0),
    Math.max((max[2] ?? 0) - (min[2] ?? 0), 0),
  ];
  const bounds: Viewport3DBounds = {
    center: [
      ((min[0] ?? 0) + (max[0] ?? 0)) / 2,
      ((min[1] ?? 0) + (max[1] ?? 0)) / 2,
      ((min[2] ?? 0) + (max[2] ?? 0)) / 2,
    ],
    radius: Math.hypot(...size) / 2,
    size,
  };
  const sampling = resolveFdmDisplaySampling(grid.totalCells, displayCellBudget);
  return {
    bounds,
    displayCellBudget: sampling.budget,
    displayCellCount: sampling.displaySamples,
    kind: "fdm-grid",
    origin: [...grid.origin],
    shape: [...grid.shape],
    spacing: [...grid.spacing],
    stride: sampling.stride,
    totalCells: sampling.total,
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
    const isAirbox = isVisualizationAirboxIdentity(part);
    if (isAirbox) {
      airboxParts.push(part);
    } else if (isInterfaceSurfacePart(part)) {
      interfaceParts.push(part);
    } else if (isMagneticRenderablePart(part)) {
      magneticParts.push(part);
      addMagneticPartAliases(magneticPartIdsByAlias, part);
    }

    if (!isAirbox) {
      addObjectPartAlias(objectPartIds, part.object_id, part.id);
      addObjectPartAlias(objectPartIds, part.geometry_id, part.id);
    }
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
  return normalizeManifestRenderableCarriers(manifest);
}

export function isFieldCapableManifestRenderCarrier(
  part: Viewport3DMeshPart,
): boolean {
  return part.fieldCapable !== false;
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
  globalCellOrdinal: string | null = null,
  elementFamily: MeshElementFamily | null = null,
): Viewport3DPartSelection {
  const objectId = visualizationObjectIdForMeshPartLike(part);
  return {
    boundaryFaceIndex,
    carrierPartId: part.id,
    elementFamily,
    globalCellOrdinal,
    kind:
      isVisualizationAirboxIdentity(part)
        ? "mesh-part-airbox"
        : "mesh-part",
    label: part.label,
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

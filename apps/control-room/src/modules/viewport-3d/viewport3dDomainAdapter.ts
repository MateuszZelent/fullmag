import type {
  DomainMetaResource,
  FdmMultilayerLayoutResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFdmMultilayerActiveMask,
  DecodedFdmRegionMembership,
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import type {
  VisualizationTargetRef,
  VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
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
import type { FdmCuboidInstanceModel } from "./layers/fdmCuboidBuildModel";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";

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

/** A physical native layer carrier; the common convolution grid is excluded. */
export interface FdmNativeLayerRenderDomain extends Omit<FdmGridRenderDomain, "kind"> {
  activeCellCount: number;
  kind: "fdm-native-layer";
  layerId: string;
  magnetName: string;
  objectId: string;
  gridFingerprint: string | null;
  transferKind: string;
  activeMaskPresent: boolean;
  inactiveCellCount: number;
}

/**
 * Published target-only FDM multilayer Airbox.  This deliberately has no
 * relationship to the FFT/common-transform grid: it is the grid certified by
 * the Airbox carrier resource itself.
 */
export interface FdmMultilayerAirboxRenderDomain extends Omit<FdmGridRenderDomain, "kind"> {
  carrierFingerprint: string;
  domainGenerationId: string;
  kind: "fdm-multilayer-airbox";
  layoutRevision: number;
  observationRevision: number;
}

export interface FdmNativeLayerRenderView {
  domain: FdmNativeLayerRenderDomain;
  fieldVector: DecodedFieldVector | null;
  model: FdmCuboidInstanceModel | null;
  settings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  target: VisualizationTargetRef;
  vectorGlyphColors: ScalarColorBuffer | null;
  vectorSegments: Float32Array | null;
}

export interface FdmMultilayerAirboxRenderView {
  domain: FdmMultilayerAirboxRenderDomain;
  fieldVector: DecodedFieldVector | null;
  model: FdmCuboidInstanceModel | null;
  settings: VisualizationTargetSettings;
  surfaceColors: ScalarColorBuffer | null;
  target: VisualizationTargetRef;
  vectorGlyphColors: ScalarColorBuffer | null;
  vectorSegments: Float32Array | null;
}

export function adaptFdmMultilayerNativeLayerDomains(
  layout: FdmMultilayerLayoutResource | null | undefined,
  displayCellBudget: number,
): FdmNativeLayerRenderDomain[] {
  if (!layout?.available) return [];
  return layout.layers.flatMap((layer) => {
    const shape: [number, number, number] = [
      layer.native_grid[0],
      layer.native_grid[1],
      layer.native_grid[2],
    ];
    const spacing: [number, number, number] = [
      layer.native_cell_size[0],
      layer.native_cell_size[1],
      layer.native_cell_size[2],
    ];
    const origin: [number, number, number] = [
      layer.native_origin[0],
      layer.native_origin[1],
      layer.native_origin[2],
    ];
    const totalCells = shape[0] * shape[1] * shape[2];
    const gridFingerprint = canonicalSha256Fingerprint(
      layer.native_grid_fingerprint,
    );
    const activeMaskHash = canonicalSha256Fingerprint(layer.active_mask_hash);
    const maskRef = layer.mask_ref?.trim() ?? "";
    const countsAreValid =
      Number.isSafeInteger(layer.active_cell_count) &&
      layer.active_cell_count >= 0 &&
      Number.isSafeInteger(layer.inactive_cell_count) &&
      layer.inactive_cell_count >= 0 &&
      layer.active_cell_count + layer.inactive_cell_count === totalCells;
    const maskDeclarationIsValid = layer.active_mask_present
      ? Boolean(activeMaskHash && maskRef)
      : layer.active_cell_count === totalCells &&
        layer.inactive_cell_count === 0 &&
        !layer.active_mask_hash &&
        !layer.mask_ref;
    if (
      shape.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      spacing.some((value) => !Number.isFinite(value) || value <= 0) ||
      origin.some((value) => !Number.isFinite(value)) ||
      !Number.isSafeInteger(totalCells) ||
      totalCells <= 0 ||
      !gridFingerprint ||
      !countsAreValid ||
      !maskDeclarationIsValid
    ) {
      return [];
    }
    const sampling = resolveFdmDisplaySampling(totalCells, displayCellBudget);
    const boundsSize: [number, number, number] = [
      shape[0] * spacing[0],
      shape[1] * spacing[1],
      shape[2] * spacing[2],
    ];
    const bounds: Viewport3DBounds = {
      center: [
        origin[0] + boundsSize[0] / 2,
        origin[1] + boundsSize[1] / 2,
        origin[2] + boundsSize[2] / 2,
      ],
      radius: Math.hypot(...boundsSize) / 2,
      size: boundsSize,
    };
    return [{
      activeCellCount: layer.active_cell_count,
      activeMaskPresent: layer.active_mask_present,
      bounds,
      displayCellBudget: sampling.budget,
      displayCellCount: sampling.displaySamples,
      gridFingerprint,
      kind: "fdm-native-layer" as const,
      layerId: layer.layer_id,
      magnetName: layer.magnet_name,
      objectId: layer.object_id,
      origin,
      shape,
      spacing,
      stride: sampling.stride,
      totalCells,
      transferKind: layer.transfer_kind,
      inactiveCellCount: layer.inactive_cell_count,
    }];
  });
}

/**
 * Accepts only an FMBM payload whose revisioned identities and cardinalities
 * still match the current native-layer layout. A declared mask never falls
 * back to dense rendering, including an all-active mask.
 */
export function resolveFdmNativeLayerActiveMaskForRendering(
  domain: FdmNativeLayerRenderDomain,
  layoutRevision: number,
  layer: FdmMultilayerLayoutResource["layers"][number] | null | undefined,
  decoded: DecodedFdmMultilayerActiveMask | null | undefined,
): Uint8Array | null {
  if (!domain.activeMaskPresent || !layer || !decoded) return null;
  const layerGridFingerprint = canonicalSha256Fingerprint(
    layer.native_grid_fingerprint,
  );
  const layerMaskHash = canonicalSha256Fingerprint(layer.active_mask_hash);
  if (
    layer.layer_id !== domain.layerId ||
    decoded.layoutRevision !== layoutRevision ||
    decoded.cellCount !== domain.totalCells ||
    decoded.activeMask.length !== domain.totalCells ||
    decoded.shape.some((count, axis) => count !== domain.shape[axis]) ||
    !layerGridFingerprint ||
    decoded.gridFingerprint !== layerGridFingerprint.slice("sha256:".length) ||
    !layerMaskHash ||
    decoded.maskHash !== layerMaskHash.slice("sha256:".length)
  ) {
    return null;
  }
  let activeCellCount = 0;
  for (const active of decoded.activeMask) {
    if (active !== 0 && active !== 1) return null;
    activeCellCount += active;
  }
  if (
    activeCellCount !== domain.activeCellCount ||
    domain.totalCells - activeCellCount !== domain.inactiveCellCount
  ) {
    return null;
  }
  return decoded.activeMask;
}

export function adaptFdmMultilayerAirboxDomain(
  layout: FdmMultilayerLayoutResource | null | undefined,
  displayCellBudget: number,
): FdmMultilayerAirboxRenderDomain | null {
  if (!layout?.available || !layout.airbox?.carrier_available) return null;
  const airbox = layout.airbox;
  const domainGenerationId = safeNonEmptyViewport3DDomainGenerationId(
    layout.domain_generation_id,
  );
  const shape = tuple3PositiveIntegers(airbox.cells);
  const spacing = tuple3PositiveFinite(airbox.cell_size_m);
  const origin = tuple3Finite(airbox.origin_m);
  const carrierFingerprint = canonicalSha256Fingerprint(airbox.carrier_fingerprint);
  const totalCells = shape ? shape[0] * shape[1] * shape[2] : 0;
  if (
    !shape ||
    !spacing ||
    !origin ||
    !domainGenerationId ||
    !carrierFingerprint ||
    airbox.target_only !== true ||
    airbox.h_demag_available !== true ||
    airbox.h_eff_available !== false ||
    !Number.isSafeInteger(airbox.sample_count) ||
    airbox.sample_count !== totalCells ||
    !Number.isSafeInteger(airbox.value_count) ||
    airbox.value_count !== totalCells * 3
  ) {
    return null;
  }
  const boundsSize: [number, number, number] = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ];
  const sampling = resolveFdmDisplaySampling(totalCells, displayCellBudget);
  return {
    bounds: {
      center: [
        origin[0] + boundsSize[0] / 2,
        origin[1] + boundsSize[1] / 2,
        origin[2] + boundsSize[2] / 2,
      ],
      radius: Math.hypot(...boundsSize) / 2,
      size: boundsSize,
    },
    carrierFingerprint,
    displayCellBudget: sampling.budget,
    displayCellCount: sampling.displaySamples,
    domainGenerationId,
    kind: "fdm-multilayer-airbox",
    layoutRevision: layout.layout_revision,
    observationRevision: layout.observation_revision,
    origin,
    shape,
    spacing,
    stride: sampling.stride,
    totalCells,
  };
}

/**
 * A multilayer Airbox carrier is only renderable when its layout generation
 * is a concrete, stable identity.  Empty and whitespace-only values must not
 * compare equal to an equally malformed FMVP generation.
 */
function safeNonEmptyViewport3DDomainGenerationId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  return value;
}

function tuple3PositiveIntegers(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function tuple3PositiveFinite(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function tuple3Finite(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (!value || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
    return null;
  }
  return [value[0]!, value[1]!, value[2]!];
}

function canonicalSha256Fingerprint(value: string | null | undefined): string | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

export function resolveFdmMultilayerAirboxFieldAvailability(
  layout: FdmMultilayerLayoutResource | null | undefined,
): { hDemagAvailable: boolean; hEffAvailable: boolean; reason: string } {
  const airbox = layout?.available ? layout.airbox : null;
  return {
    hDemagAvailable: airbox?.h_demag_available === true,
    hEffAvailable: airbox?.h_eff_available === true,
    reason: airbox?.h_eff_unavailable_reason ?? "airbox_heff_not_available_v1",
  };
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
  const presentationBounds = presentation.bounds;
  const min = presentationBounds?.min;
  const max = presentationBounds?.max;
  if (
    !Array.isArray(min) ||
    !Array.isArray(max) ||
    min.length !== 3 ||
    max.length !== 3 ||
    !min.every(Number.isFinite) ||
    !max.every(Number.isFinite)
  ) {
    return null;
  }
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

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { DecodedTopology } from "@/kernel/api/codecs";
import {
  buildPartSurfaceIndices,
  type Viewport3DSurfacePart,
} from "../viewport3dRenderModel";
import {
  buildPartSurfaceEdgeIndicesWithSupplemental,
  buildTopologySurfaceIndicesForElements,
  buildTopologySurfaceEdgeIndicesForElements,
  buildTopologyVolumeEdgeIndicesForElements,
  topologyCellAt,
} from "../viewport3dTopologyIndexModel";

export type RegionOverlayTheme = "latte" | "mocha";

type NumericVector3 = readonly [number, number, number];
type NumericQuaternion = readonly [number, number, number, number];

interface JsonRecord {
  [key: string]: unknown;
}

export interface RegionOverlayInput {
  enabled?: boolean | null;
  frame?: string | null;
  mesh_part_ids?: readonly string[] | null;
  name?: string | null;
  owner_object_id?: string | null;
  owner_transform?: unknown;
  owner_translation?: unknown;
  priority?: number | null;
  region_id?: string | null;
  shape?: components["schemas"]["SceneRegionShape"] | null;
}

export interface RegionOverlayOptions {
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
}

export interface RegionOverlayStyle {
  wireframeOpacity: number;
  wireframeScale: number;
  wireframeVisible: boolean;
  wireframeColor: string | null;
}

interface RegionOverlayTransform {
  position: NumericVector3;
  quaternion: NumericQuaternion;
  scale: NumericVector3;
}

interface RegionOverlayBaseModel {
  color: string;
  enabled: boolean;
  label: string;
  meshPartIds: readonly string[] | null;
  objectId: string;
  priority: number | null;
  regionId: string;
  selected: boolean;
  slot: number;
  style: RegionOverlayStyle;
  transform: RegionOverlayTransform;
}

interface RegionOverlayBoxModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "box";
  size: NumericVector3;
}

interface RegionOverlayCylinderModel extends RegionOverlayBaseModel {
  axis: NumericVector3;
  center: NumericVector3;
  height: number;
  kind: "cylinder";
  radius: number;
}

interface RegionOverlaySphereModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "sphere";
  radius: number;
}

export type RegionOverlayModel =
  | RegionOverlayBoxModel
  | RegionOverlayCylinderModel
  | RegionOverlaySphereModel;

type RegionMeshOverlaySelectionModel =
  | RegionOverlayModel
  | (RegionOverlayBaseModel & { meshPartIds: readonly string[] });

export interface RegionMeshOverlayOwnerPart {
  boundary_face_count?: number | null;
  boundary_face_indices?: readonly number[] | null;
  boundary_face_start?: number | null;
  element_count?: number | null;
  element_indices?: readonly number[] | null;
  element_start?: number | null;
  id?: string | null;
  node_count?: number | null;
  node_indices?: readonly number[] | null;
  node_start?: number | null;
  object_id?: string | null;
  surface_faces?: readonly (readonly number[])[] | null;
}

export interface RegionMeshOverlayModel extends RegionOverlayBaseModel {
  edgeIndices: Uint32Array | null;
  positions: Float32Array;
  surfaceEdgeIndices: Uint32Array | null;
  surfaceIndices: Uint32Array | null;
}

interface RegionMeshOverlayGeometryBuffers {
  readonly edgeIndices: Uint32Array | null;
  readonly surfaceEdgeIndices: Uint32Array | null;
  readonly surfaceIndices: Uint32Array | null;
}

const REGION_COLORS = {
  latte: [
    "var(--fm-region-overlay-0)",
    "var(--fm-region-overlay-1)",
    "var(--fm-region-overlay-2)",
    "var(--fm-region-overlay-3)",
    "var(--fm-region-overlay-4)",
    "var(--fm-region-overlay-5)",
    "var(--fm-region-overlay-6)",
    "var(--fm-region-overlay-7)",
  ],
  mocha: [
    "var(--fm-region-overlay-0)",
    "var(--fm-region-overlay-1)",
    "var(--fm-region-overlay-2)",
    "var(--fm-region-overlay-3)",
    "var(--fm-region-overlay-4)",
    "var(--fm-region-overlay-5)",
    "var(--fm-region-overlay-6)",
    "var(--fm-region-overlay-7)",
  ],
} satisfies Record<RegionOverlayTheme, readonly string[]>;

const DEFAULT_CENTER: NumericVector3 = [0, 0, 0];
const DEFAULT_AXIS: NumericVector3 = [0, 0, 1];
const DEFAULT_QUATERNION: NumericQuaternion = [0, 0, 0, 1];
const DEFAULT_SCALE: NumericVector3 = [1, 1, 1];
const REGION_MESH_OVERLAY_GEOMETRY_CACHE_LIMIT = 16;
const topologyPositionCache = new WeakMap<DecodedTopology, Float32Array>();
const regionMeshOverlayGeometryCache = new WeakMap<
  DecodedTopology,
  Map<string, RegionMeshOverlayGeometryBuffers>
>();

export function resolveRegionOverlayColor(
  slot: number,
  theme: RegionOverlayTheme = "mocha",
): string {
  const palette = REGION_COLORS[theme];
  return palette[positiveModulo(slot, palette.length)];
}

export function resolveRegionOverlayStyle({
  enabled,
  selected,
}: {
  enabled: boolean;
  selected: boolean;
}): RegionOverlayStyle {
  const wireframeVisible = enabled;
  return {
    wireframeOpacity: wireframeVisible ? (selected ? 1 : 0.72) : 0,
    wireframeScale: selected ? 1.008 : 1.004,
    wireframeVisible,
    wireframeColor: null,
  };
}

export function buildRegionOverlayModels(
  regions: readonly RegionOverlayInput[],
  options: RegionOverlayOptions = {},
): RegionOverlayModel[] {
  return [...regions]
    .filter((region) => {
      const selectedObjectId = nonEmptyString(options.selectedObjectId);
      if (!selectedObjectId) return true;
      return nonEmptyString(region.owner_object_id) === selectedObjectId;
    })
    .sort(compareRegionOverlayInputs)
    .flatMap((region, index) =>
      normalizeRegionOverlayModel(region, index, options),
    );
}

export function buildRegionMeshOverlayModels(
  regions: readonly RegionOverlayInput[],
  topology: DecodedTopology | null | undefined,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
  options: RegionOverlayOptions = {},
): RegionMeshOverlayModel[] {
  if (!topology || topology.elementCount < 1 || topology.positions.length < 3) {
    return [];
  }

  const positions = positionsForTopology(topology);

  return buildRegionMeshOverlaySelectionModels(regions, options).flatMap((region) => {
    const selectedElements = regionMeshElementIndices(region, topology, ownerParts);
    if (selectedElements.length === 0) return [];
    const selectedMeshParts = region.meshPartIds?.length
      ? meshOverlayPartsForIds(region.meshPartIds, ownerParts)
      : [];
    const geometry = cachedRegionMeshOverlayGeometry(
      topology,
      region,
      selectedElements,
      selectedMeshParts,
    );
    return [
      {
        color: region.color,
        edgeIndices: geometry.edgeIndices,
        enabled: region.enabled,
        label: region.label,
        meshPartIds: region.meshPartIds,
        objectId: region.objectId,
        positions,
        priority: region.priority,
        regionId: region.regionId,
        selected: region.selected,
        slot: region.slot,
        style: region.style,
        surfaceEdgeIndices: geometry.surfaceEdgeIndices,
        surfaceIndices: geometry.surfaceIndices,
        transform: defaultRegionTransform(),
      },
    ];
  });
}

function cachedRegionMeshOverlayGeometry(
  topology: DecodedTopology,
  region: RegionMeshOverlaySelectionModel,
  selectedElements: readonly number[],
  selectedMeshParts: readonly RegionMeshOverlayOwnerPart[],
): RegionMeshOverlayGeometryBuffers {
  const key = regionMeshOverlayGeometryCacheKey(
    region,
    selectedElements,
    selectedMeshParts,
  );
  let topologyCache = regionMeshOverlayGeometryCache.get(topology);
  if (!topologyCache) {
    topologyCache = new Map<string, RegionMeshOverlayGeometryBuffers>();
    regionMeshOverlayGeometryCache.set(topology, topologyCache);
  }
  const cached = topologyCache.get(key);
  if (cached) return cached;

  const selectedElementSet = new Set(selectedElements);

  const surfaceIndices =
    selectedMeshParts.length > 0
      ? surfaceIndicesForMeshOverlayParts(selectedMeshParts, topology) ??
        buildTopologySurfaceIndicesForElements(topology, selectedElementSet)
      : buildTopologySurfaceIndicesForElements(topology, selectedElementSet);
  const edgeIndices = buildTopologyVolumeEdgeIndicesForElements(
    topology,
    selectedElementSet,
  );
  const surfaceEdgeIndices = selectedMeshParts.length > 0
    ? surfaceEdgeIndicesForMeshOverlayParts(selectedMeshParts, topology)
    : buildTopologySurfaceEdgeIndicesForElements(topology, selectedElementSet);
  const geometry: RegionMeshOverlayGeometryBuffers = {
    edgeIndices: edgeIndices.length > 0 ? edgeIndices : null,
    surfaceEdgeIndices,
    surfaceIndices,
  };
  topologyCache.set(key, geometry);
  evictOldestRegionMeshOverlayGeometryEntries(topologyCache);
  return geometry;
}

function surfaceEdgeIndicesForMeshOverlayParts(
  parts: readonly RegionMeshOverlayOwnerPart[],
  topology: DecodedTopology,
): Uint32Array | null {
  const edges = parts.flatMap((part) => {
    const buffer = buildPartSurfaceEdgeIndicesWithSupplemental(
      normalizeRegionMeshOverlaySurfacePart(part),
      topology,
      [],
    );
    return buffer ? Array.from(buffer) : [];
  });
  const deduped: number[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < edges.length; index += 2) {
    const left = edges[index] ?? 0;
    const right = edges[index + 1] ?? 0;
    const a = Math.min(left, right);
    const b = Math.max(left, right);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(a, b);
  }
  return deduped.length ? Uint32Array.from(deduped) : null;
}

function normalizeRegionMeshOverlaySurfacePart(
  part: RegionMeshOverlayOwnerPart,
): Viewport3DSurfacePart {
  return {
    boundary_face_count: Math.max(
      0,
      Math.floor(finiteNumber(part.boundary_face_count) ?? 0),
    ),
    boundary_face_indices: part.boundary_face_indices ?? undefined,
    boundary_face_start: Math.max(
      0,
      Math.floor(finiteNumber(part.boundary_face_start) ?? 0),
    ),
    surface_faces: part.surface_faces ?? undefined,
  };
}

function evictOldestRegionMeshOverlayGeometryEntries(
  entries: Map<string, RegionMeshOverlayGeometryBuffers>,
): void {
  while (entries.size > REGION_MESH_OVERLAY_GEOMETRY_CACHE_LIMIT) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    entries.delete(oldestKey);
  }
}

function regionMeshOverlayGeometryCacheKey(
  region: RegionMeshOverlaySelectionModel,
  selectedElements: readonly number[],
  selectedMeshParts: readonly RegionMeshOverlayOwnerPart[],
): string {
  return [
    region.regionId,
    region.objectId,
    region.meshPartIds?.join(",") ?? "",
    selectedElements.join(","),
    selectedMeshParts.map(regionMeshOverlayOwnerPartCacheKey).join("|"),
  ].join("::");
}

function regionMeshOverlayOwnerPartCacheKey(
  part: RegionMeshOverlayOwnerPart,
): string {
  return JSON.stringify({
    boundary_face_count: part.boundary_face_count ?? null,
    boundary_face_indices: part.boundary_face_indices ?? null,
    boundary_face_start: part.boundary_face_start ?? null,
    element_count: part.element_count ?? null,
    element_indices: part.element_indices ?? null,
    element_start: part.element_start ?? null,
    id: part.id ?? null,
    surface_faces: part.surface_faces ?? null,
  });
}

function positionsForTopology(topology: DecodedTopology): Float32Array {
  const cached = topologyPositionCache.get(topology);
  if (cached) return cached;
  const positions =
    topology.positions instanceof Float32Array
      ? topology.positions
      : Float32Array.from(topology.positions);
  topologyPositionCache.set(topology, positions);
  return positions;
}

function meshOverlayPartsForIds(
  meshPartIdsValue: readonly string[],
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): RegionMeshOverlayOwnerPart[] {
  const selectedPartIds = new Set(meshPartIdsValue);
  return ownerParts.filter((part) => {
    const partId = nonEmptyString(part.id);
    return Boolean(partId && selectedPartIds.has(partId));
  });
}

function surfaceIndicesForMeshOverlayParts(
  parts: readonly RegionMeshOverlayOwnerPart[],
  topology: DecodedTopology,
): Uint32Array | null {
  const buffers = parts.flatMap((part) => {
    const surfaceIndices = buildPartSurfaceIndices(
      normalizeRegionMeshOverlaySurfacePart(part),
      topology,
    );
    return surfaceIndices?.length ? [surfaceIndices] : [];
  });

  return mergeRegionSurfaceIndexBuffers(buffers, topology.nodeCount);
}

function mergeRegionSurfaceIndexBuffers(
  buffers: readonly Uint32Array[],
  nodeCount: number,
): Uint32Array | null {
  const validBuffers = buffers.filter((buffer) => buffer.length >= 3);
  if (validBuffers.length === 0) return null;
  if (validBuffers.length === 1) return validBuffers[0] ?? null;

  const indices: number[] = [];
  const seen = new Set<string>();
  for (const buffer of validBuffers) {
    for (let index = 0; index + 2 < buffer.length; index += 3) {
      const a = buffer[index] ?? 0;
      const b = buffer[index + 1] ?? 0;
      const c = buffer[index + 2] ?? 0;
      if (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        !Number.isInteger(c) ||
        a < 0 ||
        b < 0 ||
        c < 0 ||
        a >= nodeCount ||
        b >= nodeCount ||
        c >= nodeCount
      ) {
        continue;
      }
      const key = [a, b, c].toSorted((left, right) => left - right).join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      indices.push(a, b, c);
    }
  }

  return indices.length > 0 ? Uint32Array.from(indices) : null;
}

function buildRegionMeshOverlaySelectionModels(
  regions: readonly RegionOverlayInput[],
  options: RegionOverlayOptions,
): RegionMeshOverlaySelectionModel[] {
  return [...regions]
    .filter((region) => {
      const selectedObjectId = nonEmptyString(options.selectedObjectId);
      if (!selectedObjectId) return true;
      return nonEmptyString(region.owner_object_id) === selectedObjectId;
    })
    .sort(compareRegionOverlayInputs)
    .flatMap<RegionMeshOverlaySelectionModel>((region, index) => {
      const partIds = meshPartIds(region.mesh_part_ids);
      if (!partIds) return normalizeRegionOverlayModel(region, index, options);

      const regionId = nonEmptyString(region.region_id);
      const objectId = nonEmptyString(region.owner_object_id);
      if (!regionId || !objectId) return [];

      const enabled = region.enabled !== false;
      const selected = options.selectedRegionId === regionId;
      const style = resolveRegionOverlayStyle({
        enabled,
        selected,
      });
      if (!style.wireframeVisible) return [];

      return [
        {
          color: resolveRegionOverlayColor(index, options.theme ?? "mocha"),
          enabled,
          label: nonEmptyString(region.name) ?? regionId,
          meshPartIds: partIds,
          objectId,
          priority: finiteNumber(region.priority),
          regionId,
          selected,
          slot: index,
          style,
          transform: defaultRegionTransform(),
        },
      ];
    });
}

function compareRegionOverlayInputs(
  left: RegionOverlayInput,
  right: RegionOverlayInput,
): number {
  const priorityDiff = priorityValue(right.priority) - priorityValue(left.priority);
  if (priorityDiff !== 0) return priorityDiff;
  return String(left.region_id ?? left.name ?? "").localeCompare(
    String(right.region_id ?? right.name ?? ""),
  );
}

function normalizeRegionOverlayModel(
  region: RegionOverlayInput,
  slot: number,
  options: RegionOverlayOptions,
): RegionOverlayModel[] {
  const shape = region.shape;
  const regionId = nonEmptyString(region.region_id);
  const objectId = nonEmptyString(region.owner_object_id);
  if (!shape || !regionId || !objectId) return [];

  const enabled = region.enabled !== false;
  const selected = options.selectedRegionId === regionId;
  const style = resolveRegionOverlayStyle({ enabled, selected });
  if (!style.wireframeVisible) return [];
  const frame = nonEmptyString(region.frame)?.toLowerCase() ?? "object";
  const transform =
    frame === "world" ? defaultRegionTransform() : ownerTransform(region);
  const base = {
    color: resolveRegionOverlayColor(slot, options.theme ?? "mocha"),
    enabled,
    label: nonEmptyString(region.name) ?? regionId,
    meshPartIds: meshPartIds(region.mesh_part_ids),
    objectId,
    priority: finiteNumber(region.priority),
    regionId,
    selected,
    slot,
    style,
    transform,
  };

  const kind = shape.kind;
  const localCenter = "center" in shape ? vector3(shape.center) : DEFAULT_CENTER;
  const center = localCenter ?? DEFAULT_CENTER;

  if (kind === "box") {
    const size = "size" in shape ? vector3(shape.size) : null;
    return size && positiveVector3(size)
      ? [{ ...base, center, kind, size }]
      : [];
  }

  if (kind === "cylinder") {
    const radius = "radius" in shape ? positiveNumber(shape.radius) : null;
    const height = "height" in shape ? positiveNumber(shape.height) : null;
    const axis = "axis" in shape ? vector3(shape.axis) : DEFAULT_AXIS;
    return radius !== null && height !== null && nonZeroVector3(axis ?? DEFAULT_AXIS)
      ? [{ ...base, axis: axis ?? DEFAULT_AXIS, center, height, kind, radius }]
      : [];
  }

  if (kind === "sphere") {
    const radius = "radius" in shape ? positiveNumber(shape.radius) : null;
    return radius !== null ? [{ ...base, center, kind, radius }] : [];
  }

  return [];
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const numberValue = finiteNumber(value);
  return numberValue !== null && numberValue > 0 ? numberValue : null;
}

function vector3(value: unknown): NumericVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const values = value.map(finiteNumber);
  return values.every((entry): entry is number => entry !== null)
    ? ([values[0], values[1], values[2]] as NumericVector3)
    : null;
}

function quaternion(value: unknown): NumericQuaternion | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const values = value.map(finiteNumber);
  return values.every((entry): entry is number => entry !== null)
    ? ([values[0], values[1], values[2], values[3]] as NumericQuaternion)
    : null;
}

function positiveVector3(value: NumericVector3): boolean {
  return value.every((entry) => entry > 0);
}

function nonZeroVector3(value: NumericVector3): boolean {
  return value.some((entry) => Math.abs(entry) > 0);
}

function meshPartIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return ids.length > 0 ? ids : null;
}

function priorityValue(value: unknown): number {
  return finiteNumber(value) ?? Number.POSITIVE_INFINITY;
}

function regionMeshElementIndices(
  region: RegionMeshOverlaySelectionModel,
  topology: DecodedTopology,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): number[] {
  if (region.meshPartIds?.length) {
    return meshPartElementIndices(region.meshPartIds, topology, ownerParts);
  }
  if (!("kind" in region)) return [];

  const ownerElementCandidates = ownerElementIndicesForRegion(
    region,
    topology,
    ownerParts,
  );
  if (ownerElementCandidates.length === 0) return [];

  return ownerElementCandidates.filter((elementIndex) => {
    const centroid = cellCentroid(topology, elementIndex);
    return centroid ? regionContainsWorldPoint(region, centroid) : false;
  });
}

function meshPartElementIndices(
  meshPartIdsValue: readonly string[],
  topology: DecodedTopology,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): number[] {
  const selectedPartIds = new Set(meshPartIdsValue);
  const candidates = new Set<number>();

  for (const part of ownerParts) {
    if (!part.id || !selectedPartIds.has(part.id)) continue;
    for (const element of elementIndicesForPart(part, topology)) {
      candidates.add(element);
    }
  }

  return Array.from(candidates).toSorted((left, right) => left - right);
}

function ownerElementIndicesForRegion(
  region: RegionOverlayModel,
  topology: DecodedTopology,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): number[] {
  const candidates = new Set<number>();

  for (const part of ownerParts) {
    if (!part.object_id || !objectIdsMatch(part.object_id, region.objectId)) {
      continue;
    }
    for (const element of elementIndicesForPart(part, topology)) {
      candidates.add(element);
    }
  }

  return Array.from(candidates).toSorted((left, right) => left - right);
}

function elementIndicesForPart(
  part: RegionMeshOverlayOwnerPart,
  topology: DecodedTopology,
): number[] {
  const topologyElementCount = topology.elementCount;
  if (part.element_indices?.length) {
    const elements = new Set<number>();
    for (const index of part.element_indices) {
      if (Number.isInteger(index) && index >= 0 && index < topologyElementCount) {
        elements.add(index);
      }
    }
    return Array.from(elements).toSorted((left, right) => left - right);
  }

  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  if (elementCount > 0 && elementStart < topologyElementCount) {
    const end = Math.min(topologyElementCount, elementStart + elementCount);
    const elements: number[] = [];
    for (let element = elementStart; element < end; element += 1) {
      elements.push(element);
    }
    return elements;
  }

  const nodeSet = nodeSetForOwnerPart(part, topology.nodeCount);
  if (!nodeSet) return [];

  const elements: number[] = [];
  for (let element = 0; element < topologyElementCount; element += 1) {
    const cell = topologyCellAt(topology, element);
    if (cell && cell.nodes.every((node) => nodeSet.has(node))) {
      elements.push(element);
    }
  }
  return elements;
}

function nodeSetForOwnerPart(
  part: RegionMeshOverlayOwnerPart,
  nodeCount: number,
): Set<number> | null {
  if (part.node_indices?.length) {
    const nodes = new Set<number>();
    for (const index of part.node_indices) {
      if (Number.isInteger(index) && index >= 0 && index < nodeCount) {
        nodes.add(index);
      }
    }
    return nodes.size > 0 ? nodes : null;
  }

  const nodeStart = Math.max(0, Math.floor(part.node_start ?? 0));
  const count = Math.max(0, Math.floor(part.node_count ?? 0));
  if (count === 0 || nodeStart >= nodeCount) return null;
  const nodes = new Set<number>();
  const end = Math.min(nodeCount, nodeStart + count);
  for (let index = nodeStart; index < end; index += 1) {
    nodes.add(index);
  }
  return nodes;
}

function objectIdsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const cleanLeft = left.endsWith("_geom") ? left.slice(0, -5) : left;
  const cleanRight = right.endsWith("_geom") ? right.slice(0, -5) : right;
  return cleanLeft === cleanRight;
}

function cellCentroid(
  topology: DecodedTopology,
  elementIndex: number,
): NumericVector3 | null {
  const cell = topologyCellAt(topology, elementIndex);
  if (!cell || cell.nodes.length === 0) return null;
  const nodes = cell.nodes;
  const centroid: [number, number, number] = [0, 0, 0];
  for (const node of nodes) {
    const offset = node * 3;
    if (offset + 2 >= topology.positions.length) return null;
    centroid[0] += topology.positions[offset] ?? 0;
    centroid[1] += topology.positions[offset + 1] ?? 0;
    centroid[2] += topology.positions[offset + 2] ?? 0;
  }
  return [
    centroid[0] / nodes.length,
    centroid[1] / nodes.length,
    centroid[2] / nodes.length,
  ];
}

function regionContainsWorldPoint(
  region: RegionOverlayModel,
  point: NumericVector3,
): boolean {
  const local = worldPointToRegionLocal(region, point);
  if (region.kind === "box") {
    return (
      Math.abs(local[0]) <= region.size[0] / 2 &&
      Math.abs(local[1]) <= region.size[1] / 2 &&
      Math.abs(local[2]) <= region.size[2] / 2
    );
  }
  if (region.kind === "sphere") {
    return vectorLengthSq(local) <= region.radius ** 2;
  }

  const axis = normalizeVector3(region.axis);
  const axial = dot(local, axis);
  if (Math.abs(axial) > region.height / 2) return false;
  const radialSq = Math.max(0, vectorLengthSq(local) - axial ** 2);
  return radialSq <= region.radius ** 2;
}

function worldPointToRegionLocal(
  region: RegionOverlayModel,
  point: NumericVector3,
): NumericVector3 {
  const translated: NumericVector3 = [
    point[0] - region.transform.position[0],
    point[1] - region.transform.position[1],
    point[2] - region.transform.position[2],
  ];
  const unrotated = rotateByQuaternion(translated, inverseQuaternion(region.transform.quaternion));
  const unscaled: NumericVector3 = [
    unrotated[0] / safeScale(region.transform.scale[0]),
    unrotated[1] / safeScale(region.transform.scale[1]),
    unrotated[2] / safeScale(region.transform.scale[2]),
  ];
  return [
    unscaled[0] - region.center[0],
    unscaled[1] - region.center[1],
    unscaled[2] - region.center[2],
  ];
}

function safeScale(value: number): number {
  return Math.abs(value) > 1e-15 ? value : 1;
}

function inverseQuaternion(quaternionValue: NumericQuaternion): NumericQuaternion {
  const normSq =
    quaternionValue[0] ** 2 +
    quaternionValue[1] ** 2 +
    quaternionValue[2] ** 2 +
    quaternionValue[3] ** 2;
  if (normSq <= 1e-30) return DEFAULT_QUATERNION;
  return [
    -quaternionValue[0] / normSq,
    -quaternionValue[1] / normSq,
    -quaternionValue[2] / normSq,
    quaternionValue[3] / normSq,
  ];
}

function rotateByQuaternion(
  vector: NumericVector3,
  quaternionValue: NumericQuaternion,
): NumericVector3 {
  const [x, y, z] = vector;
  const [qx, qy, qz, qw] = quaternionValue;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function normalizeVector3(vector: NumericVector3): NumericVector3 {
  const length = Math.sqrt(vectorLengthSq(vector));
  return length > 1e-15
    ? [vector[0] / length, vector[1] / length, vector[2] / length]
    : DEFAULT_AXIS;
}

function vectorLengthSq(vector: NumericVector3): number {
  return vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2;
}

function dot(left: NumericVector3, right: NumericVector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function positiveModulo(value: number, divisor: number): number {
  return ((Math.trunc(value) % divisor) + divisor) % divisor;
}

function defaultRegionTransform(): RegionOverlayTransform {
  return {
    position: DEFAULT_CENTER,
    quaternion: DEFAULT_QUATERNION,
    scale: DEFAULT_SCALE,
  };
}

function ownerTransform(region: RegionOverlayInput): RegionOverlayTransform {
  const transform = asRecord(region.owner_transform);
  return {
    position:
      vector3(transform?.translation) ??
      vector3(region.owner_translation) ??
      DEFAULT_CENTER,
    quaternion: quaternion(transform?.rotation_quat) ?? DEFAULT_QUATERNION,
    scale: vector3(transform?.scale) ?? DEFAULT_SCALE,
  };
}

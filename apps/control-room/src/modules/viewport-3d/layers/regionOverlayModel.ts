import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { DecodedTopology } from "@/kernel/api/codecs";
import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import { buildSurfaceEdgeIndices } from "../viewport3dSurfaceEdges";
import { buildTetraVolumeEdgeIndices } from "../viewport3dRenderModel";

export type RegionOverlayTheme = "latte" | "mocha";
export type RegionOverlayShapeKind = "box" | "cylinder" | "sphere";

type NumericVector3 = readonly [number, number, number];
type NumericQuaternion = readonly [number, number, number, number];

interface JsonRecord {
  [key: string]: unknown;
}

export interface RegionOverlayInput {
  enabled?: boolean | null;
  frame?: string | null;
  name?: string | null;
  owner_object_id?: string | null;
  owner_transform?: unknown;
  owner_translation?: unknown;
  priority?: number | null;
  region_id?: string | null;
  shape?: components["schemas"]["SceneRegionShape"] | null;
}

export interface RegionOverlayOptions {
  resolveSettings?: (region: RegionOverlayInput) => VisualizationTargetSettings;
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
}

export interface RegionOverlayStyle {
  fillOpacity: number;
  fillVisible: boolean;
  surfaceColor: string | null;
  wireframeOpacity: number;
  wireframeScale: number;
  wireframeVisible: boolean;
  wireframeColor: string | null;
}

export interface RegionOverlayTransform {
  position: NumericVector3;
  quaternion: NumericQuaternion;
  scale: NumericVector3;
}

interface RegionOverlayBaseModel {
  color: string;
  enabled: boolean;
  label: string;
  objectId: string;
  priority: number | null;
  regionId: string;
  selected: boolean;
  slot: number;
  style: RegionOverlayStyle;
  transform: RegionOverlayTransform;
}

export interface RegionOverlayBoxModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "box";
  size: NumericVector3;
}

export interface RegionOverlayCylinderModel extends RegionOverlayBaseModel {
  axis: NumericVector3;
  center: NumericVector3;
  height: number;
  kind: "cylinder";
  radius: number;
}

export interface RegionOverlaySphereModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "sphere";
  radius: number;
}

export type RegionOverlayModel =
  | RegionOverlayBoxModel
  | RegionOverlayCylinderModel
  | RegionOverlaySphereModel;

export interface RegionMeshOverlayOwnerPart {
  element_count?: number | null;
  element_start?: number | null;
  node_count?: number | null;
  node_indices?: readonly number[] | null;
  node_start?: number | null;
  object_id?: string | null;
}

export interface RegionMeshOverlayModel extends RegionOverlayBaseModel {
  edgeIndices: Uint32Array | null;
  positions: Float32Array;
  surfaceEdgeIndices: Uint32Array | null;
  surfaceIndices: Uint32Array | null;
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
  settings,
}: {
  enabled: boolean;
  selected: boolean;
  settings?: VisualizationTargetSettings | null;
}): RegionOverlayStyle {
  const targetVisible = settings?.visible ?? true;
  const fillVisible = enabled && targetVisible && (settings?.shaderVisible ?? true);
  const wireframeVisible =
    enabled && targetVisible && (settings?.wireframeVisible ?? true);
  const opacityScale = Math.max(0, Math.min(100, settings?.opacityPercent ?? 100)) / 100;
  const wireframeOpacityScale =
    Math.max(0, Math.min(100, settings?.wireframeOpacityPercent ?? 100)) / 100;
  return {
    fillOpacity: fillVisible ? (selected ? 0.25 : 0.14) * opacityScale : 0,
    fillVisible,
    surfaceColor: settings?.shaderMonoColor ?? null,
    wireframeOpacity: wireframeVisible
      ? (selected ? 1 : 0.72) * wireframeOpacityScale
      : 0,
    wireframeScale: selected ? 1.008 : 1.004,
    wireframeVisible,
    wireframeColor: settings?.wireframeColor ?? null,
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
  if (!topology || topology.indices.length < 4 || topology.positions.length < 3) {
    return [];
  }

  return buildRegionOverlayModels(regions, options).flatMap((region) => {
    const selectedElements = regionMeshElementIndices(region, topology, ownerParts);
    if (selectedElements.length === 0) return [];

    const selectedTetraIndices = new Uint32Array(selectedElements.length * 4);
    selectedElements.forEach((elementIndex, targetElement) => {
      const source = elementIndex * 4;
      const target = targetElement * 4;
      selectedTetraIndices[target] = topology.indices[source] ?? 0;
      selectedTetraIndices[target + 1] = topology.indices[source + 1] ?? 0;
      selectedTetraIndices[target + 2] = topology.indices[source + 2] ?? 0;
      selectedTetraIndices[target + 3] = topology.indices[source + 3] ?? 0;
    });

    const surfaceIndices = buildSelectedTetraBoundarySurfaceIndices(
      topology,
      selectedElements,
    );
    const edgeIndices = buildTetraVolumeEdgeIndices(selectedTetraIndices);
    const surfaceEdgeIndices = buildSurfaceEdgeIndices(surfaceIndices);
    return [
      {
        color: region.color,
        edgeIndices: edgeIndices.length > 0 ? edgeIndices : null,
        enabled: region.enabled,
        label: region.label,
        objectId: region.objectId,
        positions: Float32Array.from(topology.positions),
        priority: region.priority,
        regionId: region.regionId,
        selected: region.selected,
        slot: region.slot,
        style: region.style,
        surfaceEdgeIndices,
        surfaceIndices,
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
  const settings = options.resolveSettings?.(region) ?? null;
  const style = resolveRegionOverlayStyle({ enabled, selected, settings });
  if (!style.fillVisible && !style.wireframeVisible) return [];
  const frame = nonEmptyString(region.frame)?.toLowerCase() ?? "object";
  const transform =
    frame === "world" ? defaultRegionTransform() : ownerTransform(region);
  const base = {
    color: resolveRegionOverlayColor(slot, options.theme ?? "mocha"),
    enabled,
    label: nonEmptyString(region.name) ?? regionId,
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

function priorityValue(value: unknown): number {
  return finiteNumber(value) ?? Number.POSITIVE_INFINITY;
}

function regionMeshElementIndices(
  region: RegionOverlayModel,
  topology: DecodedTopology,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): number[] {
  const ownerElementCandidates = ownerElementIndicesForRegion(
    region,
    topology,
    ownerParts,
  );
  if (ownerElementCandidates.length === 0) return [];

  return ownerElementCandidates.filter((elementIndex) => {
    const centroid = tetraCentroid(topology, elementIndex);
    return centroid ? regionContainsWorldPoint(region, centroid) : false;
  });
}

function ownerElementIndicesForRegion(
  region: RegionOverlayModel,
  topology: DecodedTopology,
  ownerParts: readonly RegionMeshOverlayOwnerPart[],
): number[] {
  const topologyElementCount = Math.floor(topology.indices.length / 4);
  const candidates = new Set<number>();

  for (const part of ownerParts) {
    if (!part.object_id || !objectIdsMatch(part.object_id, region.objectId)) {
      continue;
    }
    const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
    const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
    if (elementCount > 0 && elementStart < topologyElementCount) {
      const end = Math.min(topologyElementCount, elementStart + elementCount);
      for (let element = elementStart; element < end; element += 1) {
        candidates.add(element);
      }
      continue;
    }

    const nodeSet = nodeSetForOwnerPart(part, topology.nodeCount);
    if (!nodeSet) continue;
    for (let element = 0; element < topologyElementCount; element += 1) {
      const source = element * 4;
      const a = topology.indices[source] ?? 0;
      const b = topology.indices[source + 1] ?? 0;
      const c = topology.indices[source + 2] ?? 0;
      const d = topology.indices[source + 3] ?? 0;
      if (nodeSet.has(a) && nodeSet.has(b) && nodeSet.has(c) && nodeSet.has(d)) {
        candidates.add(element);
      }
    }
  }

  return [...candidates].sort((left, right) => left - right);
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

function tetraCentroid(
  topology: DecodedTopology,
  elementIndex: number,
): NumericVector3 | null {
  const source = elementIndex * 4;
  if (source + 3 >= topology.indices.length) return null;
  const nodes = [
    topology.indices[source] ?? 0,
    topology.indices[source + 1] ?? 0,
    topology.indices[source + 2] ?? 0,
    topology.indices[source + 3] ?? 0,
  ];
  const centroid: [number, number, number] = [0, 0, 0];
  for (const node of nodes) {
    const offset = node * 3;
    if (offset + 2 >= topology.positions.length) return null;
    centroid[0] += topology.positions[offset] ?? 0;
    centroid[1] += topology.positions[offset + 1] ?? 0;
    centroid[2] += topology.positions[offset + 2] ?? 0;
  }
  return [centroid[0] / 4, centroid[1] / 4, centroid[2] / 4];
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

function buildSelectedTetraBoundarySurfaceIndices(
  topology: DecodedTopology,
  selectedElements: readonly number[],
): Uint32Array | null {
  const faces = new Map<string, { count: number; face: [number, number, number] }>();
  for (const elementIndex of selectedElements) {
    const source = elementIndex * 4;
    const a = topology.indices[source] ?? 0;
    const b = topology.indices[source + 1] ?? 0;
    const c = topology.indices[source + 2] ?? 0;
    const d = topology.indices[source + 3] ?? 0;
    pushBoundaryFaceCandidate(faces, [a, b, c]);
    pushBoundaryFaceCandidate(faces, [a, b, d]);
    pushBoundaryFaceCandidate(faces, [a, c, d]);
    pushBoundaryFaceCandidate(faces, [b, c, d]);
  }

  const surface: number[] = [];
  for (const entry of faces.values()) {
    if (entry.count === 1) surface.push(...entry.face);
  }
  return surface.length > 0 ? Uint32Array.from(surface) : null;
}

function pushBoundaryFaceCandidate(
  faces: Map<string, { count: number; face: [number, number, number] }>,
  face: [number, number, number],
): void {
  const key = [...face].sort((left, right) => left - right).join(":");
  const current = faces.get(key);
  if (current) {
    current.count += 1;
  } else {
    faces.set(key, { count: 1, face });
  }
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

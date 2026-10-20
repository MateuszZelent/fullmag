import type {
  MeshSharedDomainManifestResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  geometryDraftLengthValuesEqual,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import { parseDraftQuantityField } from "@/kernel/authoring/object-edit/quantityDraftFields";
import {
  isVisualizationAirboxIdentity,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import { resolveSceneRevision } from "@/kernel/visualization/visualizationDisplayResolution";
import {
  buildAuthoredMicrostripGeometry,
  buildAuthoredCpwGeometry,
  type AuthoredAntennaGeometry,
} from "@/shared/domain/geometry/authoredMicrostripGeometry";

import { magnetizationHslRgb } from "./orientation/magnetizationColor";
import type { Viewport3DBounds } from "./viewport3dRenderModel";

type Viewport3DPrimitiveKind =
  | "box"
  | "box-cylinder-difference"
  | "cylinder-cylinder-difference"
  | "cylinder"
  | "sphere"
  | "microstrip"
  | "cpw"
  | "unsupported";
type Viewport3DPrimitiveMeshState =
  | "primitive-only"
  | "mesh-stale"
  | "mesh-failed"
  | "mesh-ready";

export interface Viewport3DPrimitiveObject {
  bounds: Viewport3DBounds;
  csgPreview: Viewport3DPrimitiveCsgPreview | null;
  fallbackLabel: string;
  geometryKey: string;
  kind: Viewport3DPrimitiveKind;
  label: string;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
  meshState: Viewport3DPrimitiveMeshState;
  antennaPreview?: AuthoredAntennaGeometry;
  objectId: string;
  role?: string | null;
  sceneRevision: number;
  translation?: [number, number, number];
}

export interface Viewport3DBoxCylinderDifferencePreview {
  boxSize: [number, number, number];
  cylinderAxis: [number, number, number];
  cylinderCenter: [number, number, number];
  cylinderHeight: number;
  cylinderRadius: number;
  kind: "box-cylinder-difference";
}

export interface Viewport3DCylinderCylinderDifferencePreview {
  boundsSize: [number, number, number];
  cylinderAxis: [number, number, number];
  innerCenter: [number, number, number];
  innerHeight: number;
  innerRadius: number;
  kind: "cylinder-cylinder-difference";
  outerCenter: [number, number, number];
  outerHeight: number;
  outerRadius: number;
}

type Viewport3DPrimitiveCsgPreview =
  | Viewport3DBoxCylinderDifferencePreview
  | Viewport3DCylinderCylinderDifferencePreview;

export interface Viewport3DMagnetizationTexturePreview {
  assetId: string;
  color: string;
  label: string;
  pivot?: [number, number, number];
  presetKind: string;
  regionId?: string;
  source: "object" | "region-override";
}

export interface Viewport3DPrimitiveRenderModel {
  diagnostics?: Array<{ objectId: string; message: string }>;
  draftOverlay?: Viewport3DPrimitiveObject | null;
  objects: Viewport3DPrimitiveObject[];
  sceneRevision: number | null;
}

type JsonRecord = Record<string, unknown>;
const VORTEX_PREVIEW_RGB: [number, number, number] = [0.1529, 0.7686, 0.9098];
const RANDOM_SEEDED_PREVIEW_RGB: [number, number, number] = [0.2627, 0.8196, 0.4784];
const ANTIVORTEX_PREVIEW_RGB: [number, number, number] = [0.98, 0.49, 0.49];
const SKYRMION_PREVIEW_RGB: [number, number, number] = [0.76, 0.33, 0.94];
const DOMAIN_WALL_PREVIEW_RGB: [number, number, number] = [0.94, 0.87, 0.31];
const TWO_DOMAIN_PREVIEW_RGB: [number, number, number] = [0.95, 0.52, 0.19];
const HELICAL_PREVIEW_RGB: [number, number, number] = [0.45, 0.73, 0.98];
const CONICAL_PREVIEW_RGB: [number, number, number] = [0.99, 0.64, 0.69];
const DEFAULT_PREVIEW_RGB: [number, number, number] = [0.6235, 0.7098, 1];

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asVec3(value: unknown): [number, number, number] | null {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return [value[0], value[1], value[2]];
  }
  return null;
}

function lowerGeometryKind(value: unknown): Viewport3DPrimitiveKind {
  const kind = asString(value)?.toLowerCase() ?? "";
  if (kind.includes("box") || kind.includes("film") || kind.includes("cuboid")) {
    return "box";
  }
  if (kind.includes("cylinder") || kind.includes("disk")) {
    return "cylinder";
  }
  if (kind.includes("sphere")) {
    return "sphere";
  }
  return "unsupported";
}

function geometryDescriptorKind(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  const record = asRecord(value);
  return asString(record?.geometry_kind ?? record?.kind)?.toLowerCase() ?? "";
}

function geometryDescriptorParams(value: unknown): JsonRecord | null {
  return asRecord(asRecord(value)?.geometry_params);
}

function geometryDescriptorSize(value: unknown): [number, number, number] | null {
  const params = geometryDescriptorParams(value);
  return asVec3(params?.size) ?? asVec3(params?.dimensions);
}

function geometryDescriptorTranslation(value: unknown): [number, number, number] {
  const params = geometryDescriptorParams(value);
  return asVec3(params?.translation) ?? [0, 0, 0];
}

function geometryDescriptorAxis(value: unknown): [number, number, number] {
  const params = geometryDescriptorParams(value);
  return asVec3(params?.axis) ?? [0, 0, 1];
}

function csgPreviewFromGeometry(
  geometry: JsonRecord,
  objectTransform?: JsonRecord | null,
): Viewport3DPrimitiveCsgPreview | null {
  if (geometryDescriptorKind(geometry.geometry_kind ?? geometry.kind) !== "difference") {
    return null;
  }

  const params = asRecord(geometry.geometry_params);
  const base = asRecord(params?.base);
  const tool = asRecord(params?.tool);
  if (!base || !tool) return null;

  const baseKind = resolveGeometryDescriptor(base)?.kind ??
    geometryDescriptorKind(base.geometry_kind ?? base.kind);
  const toolKind = resolveGeometryDescriptor(tool)?.kind ??
    geometryDescriptorKind(tool.geometry_kind ?? tool.kind);

  if (baseKind === "cylinder" && toolKind === "cylinder") {
    return cylinderCylinderDifferencePreview(base, tool, objectTransform);
  }

  if (baseKind !== "box" || toolKind !== "cylinder") return null;

  const boxSize = geometryDescriptorSize(base);
  const toolParams = geometryDescriptorParams(tool);
  const cylinderRadius = asNumber(toolParams?.radius);
  const cylinderHeight = asNumber(toolParams?.height);
  if (
    !boxSize ||
    cylinderRadius === null ||
    cylinderRadius <= 0 ||
    cylinderHeight === null ||
    cylinderHeight <= 0
  ) {
    return null;
  }

  return {
    boxSize,
    cylinderAxis: geometryDescriptorAxis(tool),
    cylinderCenter: geometryDescriptorTranslation(tool),
    cylinderHeight,
    cylinderRadius,
    kind: "box-cylinder-difference",
  };
}

interface ResolvedGeometryDescriptor {
  kind: string;
  params: JsonRecord;
  translation: [number, number, number];
}

function resolveGeometryDescriptor(value: unknown): ResolvedGeometryDescriptor | null {
  let descriptor = asRecord(value);
  let translation: [number, number, number] = [0, 0, 0];
  for (let depth = 0; descriptor && depth < 8; depth += 1) {
    const kind = geometryDescriptorKind(descriptor.geometry_kind ?? descriptor.kind);
    const params = geometryDescriptorParams(descriptor) ?? {};
    const offset = asVec3(params.translation);
    if (offset) {
      translation = [
        translation[0] + offset[0],
        translation[1] + offset[1],
        translation[2] + offset[2],
      ];
    }
    if (kind !== "translate") {
      return { kind, params, translation };
    }
    descriptor = asRecord(params.base);
  }
  return null;
}

function cylinderCylinderDifferencePreview(
  base: JsonRecord,
  tool: JsonRecord,
  objectTransform?: JsonRecord | null,
): Viewport3DCylinderCylinderDifferencePreview | null {
  if (!supportsUnrotatedUnitScaleTransform(objectTransform)) return null;
  const outer = resolveGeometryDescriptor(base);
  const inner = resolveGeometryDescriptor(tool);
  if (!outer || !inner || outer.kind !== "cylinder" || inner.kind !== "cylinder") {
    return null;
  }

  const outerRadius = asNumber(outer.params.radius);
  const outerHeight = asNumber(outer.params.height);
  const innerRadius = asNumber(inner.params.radius);
  const innerHeight = asNumber(inner.params.height);
  const cylinderAxis = asVec3(outer.params.axis) ?? [0, 0, 1];
  const innerAxis = asVec3(inner.params.axis) ?? [0, 0, 1];
  const axisIndex = cardinalAxisIndex(cylinderAxis);
  if (
    outerRadius === null || outerRadius <= 0 ||
    outerHeight === null || outerHeight <= 0 ||
    innerRadius === null || innerRadius <= 0 ||
    innerHeight === null || innerHeight <= 0 ||
    innerRadius >= outerRadius ||
    axisIndex === null || cardinalAxisIndex(innerAxis) !== axisIndex
  ) {
    return null;
  }

  const coordinateScale = Math.max(
    ...outer.translation.map(Math.abs),
    ...inner.translation.map(Math.abs),
  );
  const tolerance = Math.max(
    Math.max(outerRadius, innerRadius, outerHeight, innerHeight) * 1e-9,
    coordinateScale * Number.EPSILON * 128,
  );
  const planeAxes = planeAxesForCardinalAxis(axisIndex);
  if (planeAxes.some((axis) =>
    Math.abs(inner.translation[axis] - outer.translation[axis]) > tolerance
  )) {
    return null;
  }
  const axialOffset = inner.translation[axisIndex] - outer.translation[axisIndex];
  if (Math.abs(axialOffset) + outerHeight / 2 > innerHeight / 2 + tolerance) {
    return null;
  }

  const boundsSize: [number, number, number] = [
    2 * outerRadius,
    2 * outerRadius,
    2 * outerRadius,
  ];
  boundsSize[axisIndex] = outerHeight;
  return {
    boundsSize,
    cylinderAxis,
    innerCenter: inner.translation,
    innerHeight,
    innerRadius,
    kind: "cylinder-cylinder-difference",
    outerCenter: outer.translation,
    outerHeight,
    outerRadius,
  };
}

function supportsUnrotatedUnitScaleTransform(
  transform?: JsonRecord | null,
): boolean {
  if (!transform) return true;
  const rotationQuat = transform.rotation_quat;
  if (rotationQuat !== undefined && rotationQuat !== null) {
    if (
      !Array.isArray(rotationQuat) ||
      rotationQuat.length !== 4 ||
      !rotationQuat.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return false;
    }
    const [x, y, z, w] = rotationQuat;
    if (
      Math.abs(x) > 1e-12 ||
      Math.abs(y) > 1e-12 ||
      Math.abs(z) > 1e-12 ||
      Math.abs(Math.abs(w) - 1) > 1e-12
    ) {
      return false;
    }
  }
  const rotation = transform.rotation;
  if (rotation !== undefined && rotation !== null) {
    const vector = asVec3(rotation);
    if (!vector || vector.some((value) => Math.abs(value) > 1e-12)) return false;
  }
  const scale = transform.scale;
  if (scale !== undefined && scale !== null) {
    const vector = asVec3(scale);
    if (!vector || vector.some((value) => Math.abs(value - 1) > 1e-12)) return false;
  }
  return true;
}

function cylinderDifferenceFallbackBounds(
  geometry: JsonRecord,
): { center: [number, number, number]; size: [number, number, number] } | null {
  if (geometryDescriptorKind(geometry.geometry_kind ?? geometry.kind) !== "difference") {
    return null;
  }
  const base = resolveGeometryDescriptor(asRecord(asRecord(geometry.geometry_params)?.base));
  if (!base || base.kind !== "cylinder") return null;
  const radius = asNumber(base.params.radius);
  const height = asNumber(base.params.height);
  if (radius === null || radius <= 0 || height === null || height <= 0) return null;
  const axisIndex = cardinalAxisIndex(asVec3(base.params.axis) ?? [0, 0, 1]);
  const diameter = 2 * radius;
  const size: [number, number, number] = axisIndex === null
    ? [Math.max(diameter, height), Math.max(diameter, height), Math.max(diameter, height)]
    : [diameter, diameter, diameter];
  if (axisIndex !== null) size[axisIndex] = height;
  return { center: base.translation, size };
}

function boundsFromMinMax(
  min: [number, number, number],
  max: [number, number, number],
): Viewport3DBounds {
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

function boundsSizeFromParams(
  geometry: JsonRecord,
  params: JsonRecord | null,
): [number, number, number] | null {
  const kind = lowerGeometryKind(geometry.geometry_kind ?? geometry.kind);
  const radius = asNumber(params?.radius);
  const height = asNumber(params?.height);
  if (kind === "cylinder" && radius !== null && height !== null) {
    const diameter = Math.max(radius * 2, 1e-12);
    return [diameter, diameter, Math.max(height, 1e-12)];
  }
  if (kind === "sphere" && radius !== null) {
    const diameter = Math.max(radius * 2, 1e-12);
    return [diameter, diameter, diameter];
  }
  return (
    asVec3(params?.size) ??
    asVec3(params?.dimensions) ??
    radiusSize(params?.radius) ??
    null
  );
}

function boundsFromGeometry(
  geometry: JsonRecord,
  transform: JsonRecord | null,
): Viewport3DBounds {
  const min = asVec3(geometry.bounds_min);
  const max = asVec3(geometry.bounds_max);
  if (min && max) return boundsFromMinMax(min, max);

  const params = asRecord(geometry.geometry_params);
  const csgPreview = csgPreviewFromGeometry(geometry, transform);
  const csgFallbackBounds = csgPreview
    ? null
    : cylinderDifferenceFallbackBounds(geometry);
  const csgSize = csgPreview?.kind === "box-cylinder-difference"
    ? csgPreview.boxSize
    : csgPreview?.kind === "cylinder-cylinder-difference"
      ? csgPreview.boundsSize
      : null;
  const size =
    csgSize ??
    csgFallbackBounds?.size ??
    boundsSizeFromParams(geometry, params) ??
    [1, 1, 1];
  const objectTranslation = asVec3(transform?.translation) ?? [0, 0, 0];
  const geometryCenter = csgPreview?.kind === "cylinder-cylinder-difference"
    ? csgPreview.outerCenter
    : csgFallbackBounds?.center ?? [0, 0, 0];
  const translation: [number, number, number] = [
    objectTranslation[0] + geometryCenter[0],
    objectTranslation[1] + geometryCenter[1],
    objectTranslation[2] + geometryCenter[2],
  ];
  const half: [number, number, number] = [
    size[0] / 2,
    size[1] / 2,
    size[2] / 2,
  ];
  return boundsFromMinMax(
    [
      translation[0] - half[0],
      translation[1] - half[1],
      translation[2] - half[2],
    ],
    [
      translation[0] + half[0],
      translation[1] + half[1],
      translation[2] + half[2],
    ],
  );
}

function radiusSize(value: unknown): [number, number, number] | null {
  const radius = asNumber(value);
  if (radius === null) return null;
  const diameter = Math.max(radius * 2, 1e-12);
  return [diameter, diameter, diameter];
}

function objectIdsWithMesh(
  manifest: MeshSharedDomainManifestResource | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const part of manifest?.mesh_parts ?? []) {
    addObjectIdAlias(ids, part.object_id);
    addObjectIdAlias(ids, part.geometry_id);
  }
  return ids;
}

function addObjectIdAlias(
  ids: Set<string>,
  objectId: string | null | undefined,
): void {
  if (!objectId) return;
  ids.add(objectId);
  if (objectId.endsWith("_geom")) {
    ids.add(objectId.slice(0, -5));
  } else {
    ids.add(`${objectId}_geom`);
  }
}

function objectMeshState(
  objectId: string,
  sceneRevision: number,
  manifest: MeshSharedDomainManifestResource | null | undefined,
  object?: JsonRecord | null,
): Viewport3DPrimitiveMeshState | "mesh-ready" {
  const meshObjectIds = objectIdsWithMesh(manifest);
  if (!meshObjectIds.has(objectId)) return "primitive-only";

  const tags = Array.isArray(object?.tags) ? object.tags.map(String) : [];
  if (
    tags.includes("mesh:failed") ||
    tags.includes("mesh:validation-blocked")
  ) {
    return "mesh-failed";
  }
  if (tags.includes("mesh:dirty") || tags.includes("mesh:building")) {
    return "mesh-stale";
  }
  const geometry = asRecord(object?.geometry);
  const requiresCurrentScene = objectHasCsgPreview(object) ||
    geometry?.geometry_kind === "MicrostripAntennaLayout" || geometry?.geometry_kind === "CPWAntennaLayout";
  if (requiresCurrentScene && manifestSceneRevision(manifest) !== sceneRevision) {
    return "mesh-stale";
  }

  return "mesh-ready";
}

function manifestSceneRevision(
  manifest: MeshSharedDomainManifestResource | null | undefined,
): number | null {
  const revision = manifest?.source_scene_revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

function objectHasCsgPreview(object: JsonRecord | null | undefined): boolean {
  const geometry = asRecord(object?.geometry);
  return Boolean(geometry && csgPreviewFromGeometry(
    geometry,
    asRecord(object?.transform),
  ));
}

function magnetizationAssetById(scene: JsonRecord, assetId: string | null): JsonRecord | null {
  if (!assetId || !Array.isArray(scene.magnetization_assets)) return null;
  return (
    scene.magnetization_assets
      .map(asRecord)
      .find((asset) => asString(asset?.id) === assetId) ?? null
  );
}

function firstRegionOverrideMagnetizationRef(
  object: JsonRecord,
): { assetId: string; regionId: string } | null {
  const overrides = asRecord(object.region_overrides);
  if (!overrides) return null;
  for (const [regionId, value] of Object.entries(overrides)) {
    const override = asRecord(value);
    const assetId = asString(override?.magnetization_ref);
    if (assetId) return { assetId, regionId };
  }
  return null;
}

function magnetizationPreviewColor(
  presetKind: string,
  asset: JsonRecord,
): string {
  if (presetKind === "uniform") {
    return rgbToHex(
      magnetizationHslRgb(
        ...(asVec3(asRecord(asset.preset_params)?.direction) ?? [1, 0, 0]),
      ),
    );
  }
  if (presetKind === "vortex") return rgbToHex(VORTEX_PREVIEW_RGB);
  if (presetKind === "antivortex") return rgbToHex(ANTIVORTEX_PREVIEW_RGB);
  if (presetKind === "random_seeded" || presetKind === "random") return rgbToHex(RANDOM_SEEDED_PREVIEW_RGB);
  if (presetKind === "bloch_skyrmion" || presetKind === "neel_skyrmion" || presetKind === "bimeron") return rgbToHex(SKYRMION_PREVIEW_RGB);
  if (presetKind === "domain_wall") return rgbToHex(DOMAIN_WALL_PREVIEW_RGB);
  if (presetKind === "two_domain") return rgbToHex(TWO_DOMAIN_PREVIEW_RGB);
  if (presetKind === "helical") return rgbToHex(HELICAL_PREVIEW_RGB);
  if (presetKind === "conical") return rgbToHex(CONICAL_PREVIEW_RGB);
  return rgbToHex(DEFAULT_PREVIEW_RGB);
}

function rgbToHex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function magnetizationTexturePreview(
  scene: JsonRecord,
  object: JsonRecord,
): Viewport3DMagnetizationTexturePreview | null {
  const regionOverride = firstRegionOverrideMagnetizationRef(object);
  const assetId = regionOverride?.assetId ?? asString(object.magnetization_ref);
  const asset = magnetizationAssetById(scene, assetId);
  if (!assetId || !asset) return null;
  const presetKind =
    asString(asset.preset_kind) ?? asString(asset.kind) ?? "texture";
  const pivot = asVec3(asRecord(asset.texture_transform)?.pivot);
  return {
    assetId,
    color: magnetizationPreviewColor(presetKind, asset),
    label:
      asString(asset.ui_label) ??
      asString(asset.name) ??
      asString(asset.preset_kind) ??
      assetId,
    ...(pivot ? { pivot } : {}),
    presetKind,
    regionId: regionOverride?.regionId,
    source: regionOverride ? "region-override" : "object",
  };
}

export function buildViewport3DMagnetizationTexturePreviewMap(
  scene: SceneResource | null | undefined,
): Map<string, Viewport3DMagnetizationTexturePreview> {
  const sceneRecord = asRecord(scene);
  const previews = new Map<string, Viewport3DMagnetizationTexturePreview>();
  if (!sceneRecord || !Array.isArray(sceneRecord.objects)) return previews;

  for (const value of sceneRecord.objects) {
    const object = asRecord(value);
    const objectId = asString(object?.id);
    if (!object || !objectId) continue;
    const preview = magnetizationTexturePreview(sceneRecord, object);
    if (preview) previews.set(objectId, preview);
  }

  return previews;
}

function fallbackLabel(state: Viewport3DPrimitiveMeshState): string {
  if (state === "mesh-stale") return "stale primitive";
  if (state === "mesh-failed") return "failed primitive";
  return "primitive";
}

function geometryKey(
  objectId: string,
  geometry: JsonRecord,
  transform: JsonRecord | null,
): string {
  return [
    objectId,
    asString(geometry.geometry_kind) ?? asString(geometry.kind) ?? "object",
    primitiveKeyValue(geometry.geometry_params ?? {}),
    primitiveKeyValue(transform ?? {}),
  ].join(":");
}

function primitiveKindFromGeometry(
  geometry: JsonRecord,
  transform?: JsonRecord | null,
): Viewport3DPrimitiveKind {
  const csgPreview = csgPreviewFromGeometry(geometry, transform);
  if (csgPreview) return csgPreview.kind;
  return lowerGeometryKind(geometry.geometry_kind ?? geometry.kind);
}

function primitiveKeyValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(primitiveKeyValue).join(",")}]`;
  }
  if (isKeyRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${quotePrimitiveKeyString(key)}:${primitiveKeyValue(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return quotePrimitiveKeyString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "null";
}

function isKeyRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quotePrimitiveKeyString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildViewport3DPrimitiveRenderModel(
  scene: SceneResource | null | undefined,
  manifest: MeshSharedDomainManifestResource | null | undefined,
): Viewport3DPrimitiveRenderModel {
  const sceneRecord = asRecord(scene);
  const sceneRevision = resolveSceneRevision(sceneRecord);
  if (!sceneRecord || sceneRevision === null || !Array.isArray(sceneRecord.objects)) {
    return { objects: [], sceneRevision };
  }

  const diagnostics: NonNullable<Viewport3DPrimitiveRenderModel["diagnostics"]> = [];
  const objects = sceneRecord.objects.flatMap((value): Viewport3DPrimitiveObject[] => {
    const object = asRecord(value);
    const objectId = asString(object?.id);
    const objectRole = asString(object?.role);
    const geometry = asRecord(object?.geometry);
    if (
      !object ||
      !objectId ||
      isVisualizationAirboxIdentity({ id: objectId, role: objectRole }) ||
      !geometry
    ) {
      return [];
    }

    const state = objectMeshState(objectId, sceneRevision, manifest, object);
    const transform = asRecord(object.transform);
    const csgPreview = csgPreviewFromGeometry(geometry, transform);
    let antennaPreview: AuthoredAntennaGeometry | undefined;
    if (geometry.geometry_kind === "MicrostripAntennaLayout" || geometry.geometry_kind === "CPWAntennaLayout") {
      try {
        antennaPreview = geometry.geometry_kind === "CPWAntennaLayout"
          ? buildAuthoredCpwGeometry(geometry.geometry_params, object.transform)
          : buildAuthoredMicrostripGeometry(geometry.geometry_params, object.transform);
      } catch (error) {
        diagnostics.push({ objectId, message: error instanceof Error ? error.message : String(error) });
        return [];
      }
    }
    return [
      {
        bounds: antennaPreview
          ? boundsFromMinMax(antennaPreview.boundsMin, antennaPreview.boundsMax)
          : boundsFromGeometry(geometry, transform),
        csgPreview,
        fallbackLabel: fallbackLabel(state),
        geometryKey: geometryKey(objectId, geometry, transform),
        kind: antennaPreview ? geometry.geometry_kind === "CPWAntennaLayout" ? "cpw" : "microstrip" : primitiveKindFromGeometry(geometry, transform),
        label: asString(object.name) ?? objectId,
        magnetizationTexturePreview: magnetizationTexturePreview(
          sceneRecord,
          object,
        ),
        meshState: state,
        antennaPreview,
        objectId,
        role: objectRole,
        sceneRevision,
        translation: asVec3(transform?.translation) ?? [0, 0, 0],
      },
    ];
  });

  return {
    diagnostics,
    objects,
    sceneRevision,
  };
}

export function withObjectPlacementDraftPreview(
  model: Viewport3DPrimitiveRenderModel | null | undefined,
  draft: GeometryObjectDraft | null,
  selectedObjectId: string | null,
): Viewport3DPrimitiveRenderModel | null | undefined {
  if (
    !model ||
    !draft ||
    draft.mode !== "committed" ||
    draft.objectId !== selectedObjectId
  ) {
    return model;
  }

  const object = model.objects.find((candidate) => candidate.objectId === draft.objectId);
  if (!object) return model;
  const translationFields = [
    "translation.0",
    "translation.1",
    "translation.2",
  ] as const;
  const parsedTranslation = translationFields.map((field) =>
    parseDraftQuantityField(draft, field),
  );
  const translation: [number | null, number | null, number | null] = [
    parsedTranslation[0]?.parseStatus === "valid"
      ? parsedTranslation[0].parsedSI
      : parsedTranslation[0]?.lastValidSI ?? null,
    parsedTranslation[1]?.parseStatus === "valid"
      ? parsedTranslation[1].parsedSI
      : parsedTranslation[1]?.lastValidSI ?? null,
    parsedTranslation[2]?.parseStatus === "valid"
      ? parsedTranslation[2].parsedSI
      : parsedTranslation[2]?.lastValidSI ?? null,
  ];
  const [translationX, translationY, translationZ] = translation;
  if (translationX === null || translationY === null || translationZ === null) {
    return model;
  }
  const translatedValues: [number, number, number] = [
    translationX,
    translationY,
    translationZ,
  ];
  const currentTranslation = object.translation ?? [0, 0, 0];
  const characteristicLength = Math.max(
    ...object.bounds.size.map((value) => Math.abs(value)),
    0,
  );
  if (translatedValues.every((value, index) =>
    geometryDraftLengthValuesEqual(
      value,
      currentTranslation[index],
      characteristicLength,
    ),
  )) {
    return model;
  }

  const delta = translatedValues.map((value, index) => value - currentTranslation[index]);
  const preview: Viewport3DPrimitiveObject = {
    ...object,
    bounds: {
      ...object.bounds,
      center: object.bounds.center.map(
        (value, index) => value + delta[index],
      ) as [number, number, number],
    },
    geometryKey: `${object.geometryKey}|placement-draft:${translatedValues.join(",")}`,
    translation: translatedValues,
  };

  return {
    ...model,
    draftOverlay: preview,
    objects: model.objects.map((candidate) =>
      candidate.objectId === draft.objectId ? preview : candidate,
    ),
  };
}

export function buildViewport3DPrimitiveFrameKey(
  primitiveModel: Viewport3DPrimitiveRenderModel | null | undefined,
): string {
  if (!primitiveModel?.objects.length && !primitiveModel?.draftOverlay) {
    return `${primitiveModel?.sceneRevision ?? "none"}:empty`;
  }
  return [
    primitiveModel.sceneRevision ?? "none",
    ...primitiveModel.objects.map((object) => object.geometryKey),
    primitiveModel.draftOverlay?.geometryKey ?? "no-draft",
  ].join("|");
}

export function resolvePrimitiveSelectionBounds(
  selection: Selection,
  primitiveModel: Viewport3DPrimitiveRenderModel | null | undefined,
): Viewport3DBounds | null {
  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId;
  if (!objectId) return null;
  return (
    primitiveModel?.objects.find((object) => object.objectId === objectId)
      ?.bounds ?? null
  );
}

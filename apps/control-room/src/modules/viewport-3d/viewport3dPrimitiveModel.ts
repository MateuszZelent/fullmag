import type {
  MeshSharedDomainManifestResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  isVisualizationAirboxIdentity,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import { resolveSceneRevision } from "@/kernel/visualization/visualizationDisplayResolution";

import { magnetizationHslRgb } from "./orientation/magnetizationColor";
import type { Viewport3DBounds } from "./viewport3dRenderModel";

type Viewport3DPrimitiveKind =
  | "box"
  | "box-cylinder-difference"
  | "cylinder"
  | "sphere"
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
  objectId: string;
  sceneRevision: number;
}

export interface Viewport3DBoxCylinderDifferencePreview {
  boxSize: [number, number, number];
  cylinderAxis: [number, number, number];
  cylinderCenter: [number, number, number];
  cylinderHeight: number;
  cylinderRadius: number;
  kind: "box-cylinder-difference";
}

type Viewport3DPrimitiveCsgPreview =
  Viewport3DBoxCylinderDifferencePreview;

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
): Viewport3DPrimitiveCsgPreview | null {
  if (geometryDescriptorKind(geometry.geometry_kind ?? geometry.kind) !== "difference") {
    return null;
  }

  const params = asRecord(geometry.geometry_params);
  const base = asRecord(params?.base);
  const tool = asRecord(params?.tool);
  if (!base || !tool) return null;

  const baseKind = geometryDescriptorKind(base.geometry_kind ?? base.kind);
  const toolKind = geometryDescriptorKind(tool.geometry_kind ?? tool.kind);
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

function boundsFromGeometry(
  geometry: JsonRecord,
  transform: JsonRecord | null,
): Viewport3DBounds {
  const min = asVec3(geometry.bounds_min);
  const max = asVec3(geometry.bounds_max);
  if (min && max) return boundsFromMinMax(min, max);

  const params = asRecord(geometry.geometry_params);
  const csgPreview = csgPreviewFromGeometry(geometry);
  const size =
    csgPreview?.boxSize ??
    asVec3(params?.size) ??
    asVec3(params?.dimensions) ??
    radiusSize(params?.radius) ??
    [1, 1, 1];
  const translation = asVec3(transform?.translation) ?? [0, 0, 0];
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
  if (objectHasCsgPreview(object) && manifestSceneRevision(manifest) !== sceneRevision) {
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
  return Boolean(geometry && csgPreviewFromGeometry(geometry));
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

function primitiveKindFromGeometry(geometry: JsonRecord): Viewport3DPrimitiveKind {
  const csgPreview = csgPreviewFromGeometry(geometry);
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
    const csgPreview = csgPreviewFromGeometry(geometry);
    return [
      {
        bounds: boundsFromGeometry(geometry, transform),
        csgPreview,
        fallbackLabel: fallbackLabel(state),
        geometryKey: geometryKey(objectId, geometry, transform),
        kind: primitiveKindFromGeometry(geometry),
        label: asString(object.name) ?? objectId,
        magnetizationTexturePreview: magnetizationTexturePreview(
          sceneRecord,
          object,
        ),
        meshState: state,
        objectId,
        sceneRevision,
      },
    ];
  });

  return {
    objects,
    sceneRevision,
  };
}

export function buildViewport3DPrimitiveFrameKey(
  primitiveModel: Viewport3DPrimitiveRenderModel | null | undefined,
): string {
  if (!primitiveModel?.objects.length) {
    return `${primitiveModel?.sceneRevision ?? "none"}:empty`;
  }
  return [
    primitiveModel.sceneRevision ?? "none",
    ...primitiveModel.objects.map((object) => object.geometryKey),
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

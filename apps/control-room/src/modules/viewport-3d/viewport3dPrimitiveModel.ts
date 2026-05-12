import type {
  MeshSharedDomainManifestResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { magnetizationHslRgb } from "./orientation/magnetizationColor";
import type { Viewport3DBounds } from "./viewport3dRenderModel";

export type Viewport3DPrimitiveKind = "box" | "cylinder" | "sphere" | "unsupported";
export type Viewport3DPrimitiveMeshState =
  | "primitive-only"
  | "mesh-stale"
  | "mesh-failed";

export interface Viewport3DPrimitiveObject {
  bounds: Viewport3DBounds;
  fallbackLabel: string;
  geometryKey: string;
  kind: Viewport3DPrimitiveKind;
  label: string;
  magnetizationTexturePreview: Viewport3DMagnetizationTexturePreview | null;
  meshState: Viewport3DPrimitiveMeshState;
  objectId: string;
  sceneRevision: number;
}

export interface Viewport3DMagnetizationTexturePreview {
  assetId: string;
  color: string;
  label: string;
  presetKind: string;
  regionId?: string;
  source: "object" | "region-override";
}

export interface Viewport3DPrimitiveRenderModel {
  objects: Viewport3DPrimitiveObject[];
  sceneRevision: number | null;
}

type JsonRecord = Record<string, unknown>;

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
  const size =
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
    if (part.object_id) ids.add(part.object_id);
  }
  return ids;
}

function objectMeshState(
  objectId: string,
  sceneRevision: number,
  manifest: MeshSharedDomainManifestResource | null | undefined,
): Viewport3DPrimitiveMeshState | "mesh-ready" {
  const meshObjectIds = objectIdsWithMesh(manifest);
  if (!meshObjectIds.has(objectId)) return "primitive-only";
  return manifest?.source_scene_revision === sceneRevision
    ? "mesh-ready"
    : "mesh-stale";
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
  if (presetKind === "vortex") return "#27c4e8";
  if (presetKind === "random_seeded") return "#43d17a";
  return "#9fb5ff";
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
  return {
    assetId,
    color: magnetizationPreviewColor(presetKind, asset),
    label:
      asString(asset.ui_label) ??
      asString(asset.name) ??
      asString(asset.preset_kind) ??
      assetId,
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
    JSON.stringify(geometry.geometry_params ?? {}),
    JSON.stringify(transform ?? {}),
  ].join(":");
}

export function buildViewport3DPrimitiveRenderModel(
  scene: SceneResource | null | undefined,
  manifest: MeshSharedDomainManifestResource | null | undefined,
): Viewport3DPrimitiveRenderModel {
  const sceneRecord = asRecord(scene);
  const sceneRevision = asNumber(sceneRecord?.revision);
  if (!sceneRecord || sceneRevision === null || !Array.isArray(sceneRecord.objects)) {
    return { objects: [], sceneRevision };
  }

  const objects = sceneRecord.objects.flatMap((value): Viewport3DPrimitiveObject[] => {
    const object = asRecord(value);
    const objectId = asString(object?.id);
    const geometry = asRecord(object?.geometry);
    if (!object || !objectId || !geometry) return [];

    const state = objectMeshState(objectId, sceneRevision, manifest);
    if (state === "mesh-ready") return [];

    const transform = asRecord(object.transform);
    return [
      {
        bounds: boundsFromGeometry(geometry, transform),
        fallbackLabel: fallbackLabel(state),
        geometryKey: geometryKey(objectId, geometry, transform),
        kind: lowerGeometryKind(geometry.geometry_kind ?? geometry.kind),
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

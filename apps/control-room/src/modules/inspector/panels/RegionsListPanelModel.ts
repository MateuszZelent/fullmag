import type {
  JsonObject,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

interface JsonRecord {
  [key: string]: unknown;
}

export type RegionShapeKind = "box" | "cylinder" | "sphere";

export interface RegionsListItem {
  colorIndex: number;
  enabled: boolean;
  name: string;
  objectId: string;
  priority: number;
  realizationPolicy: string;
  realizationStatus: string;
  regionId: string;
  shapeKind: string;
}

export interface RegionsListPanelModel {
  items: RegionsListItem[];
  mode: "committed" | "missing";
  objectId: string;
  ownerBounds: RegionOwnerBounds | null;
  objectLabel: string;
  revision: number | null;
}

export interface NewRegionDraft {
  name: string;
  priority: number;
  shapeKind: RegionShapeKind;
}

export interface RegionOwnerBounds {
  center: [number, number, number];
  size: [number, number, number];
}

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
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : null;
}

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selectedObjectId(selection);
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function regionOwnerMatches(
  region: RegionListResource["regions"][number],
  objectId: string,
): boolean {
  return (
    region.owner_object_id === objectId ||
    region.source_object_ids.includes(objectId)
  );
}

function shapeKindForRegion(region: RegionListResource["regions"][number]): string {
  const shape = asRecord(region.shape);
  return asString(shape?.kind) ?? "region";
}

function ownerBoundsForObject(object: JsonRecord | null): RegionOwnerBounds | null {
  const geometry = asRecord(object?.geometry);
  const min = asVec3(geometry?.bounds_min ?? object?.bounds_min);
  const max = asVec3(geometry?.bounds_max ?? object?.bounds_max);
  if (!min || !max) return ownerBoundsFromGeometryParams(geometry);
  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  if (size.some((entry) => entry <= 0 || !Number.isFinite(entry))) return null;
  return {
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
    size,
  };
}

function ownerBoundsFromGeometryParams(geometry: JsonRecord | null): RegionOwnerBounds | null {
  const params = asRecord(geometry?.geometry_params);
  const kind = asString(geometry?.geometry_kind);
  const center = asVec3(params?.center) ?? [0, 0, 0];
  let size: [number, number, number] | null = null;
  if (kind === "Box") {
    size = asVec3(params?.size);
  } else if (kind === "Cylinder") {
    const radius = asNumber(params?.radius);
    const height = asNumber(params?.height);
    if (radius && height) {
      size = [radius * 2, radius * 2, height];
    }
  } else if (kind === "ArchWaveguide") {
    const length = asNumber(params?.length);
    const width = asNumber(params?.width);
    const height = asNumber(params?.height);
    if (length && width && height) {
      size = [length, width, height];
    }
  }
  if (!size || size.some((entry) => entry <= 0 || !Number.isFinite(entry))) {
    return null;
  }
  return { center, size };
}

export function resolveRegionsListPanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regions: RegionListResource | null,
): RegionsListPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  if (!object || !objectId) {
    return {
      items: [],
      mode: "missing",
      objectId: objectId ?? "none",
      ownerBounds: null,
      objectLabel: objectId ?? "none",
      revision,
    };
  }

  const items = (regions?.regions ?? [])
    .filter(
      (region) =>
        region.source === "authored_object_region" &&
        regionOwnerMatches(region, objectId),
    )
    .sort((left, right) => {
      const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      return left.name.localeCompare(right.name);
    })
    .map((region, index) => ({
      colorIndex: index % 8,
      enabled: region.enabled,
      name: region.name,
      objectId,
      priority: region.priority ?? 0,
      realizationPolicy: region.realization_policy ?? "inherit",
      realizationStatus: region.realization_status ?? "authored_pending",
      regionId: region.region_id,
      shapeKind: shapeKindForRegion(region),
    }));

  return {
    items,
    mode: "committed",
    objectId,
    ownerBounds: ownerBoundsForObject(object),
    objectLabel: asString(object.name) ?? objectId,
    revision,
  };
}

export function defaultNewRegionDraft(): NewRegionDraft {
  return {
    name: "",
    priority: 0,
    shapeKind: "box",
  };
}

export function validateNewRegionDraft(draft: NewRegionDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) {
    errors.push("Region name is required.");
  }
  if (!Number.isFinite(draft.priority) || !Number.isInteger(draft.priority)) {
    errors.push("Region priority must be an integer.");
  }
  if (!["box", "cylinder", "sphere"].includes(draft.shapeKind)) {
    errors.push("Region shape must be box, cylinder, or sphere.");
  }
  return errors;
}

export function buildNewRegionPayload(
  draft: NewRegionDraft,
  ownerBounds: RegionOwnerBounds | null = null,
): JsonObject {
  const name = draft.name.trim();
  const priority = Number.isFinite(draft.priority) ? draft.priority : 0;
  const center = ownerBounds?.center ?? [0, 0, 0];
  const ownerSize = ownerBounds?.size ?? [100e-9, 100e-9, 100e-9];
  const boxSize = ownerSize.map((entry) => entry * 0.5) as [
    number,
    number,
    number,
  ];
  let shape: JsonObject;
  if (draft.shapeKind === "cylinder") {
    shape = {
      axis: [0, 0, 1],
      center,
      height: boxSize[2],
      kind: "cylinder",
      radius: Math.min(boxSize[0], boxSize[1]) / 2,
    };
  } else if (draft.shapeKind === "sphere") {
    shape = {
      center,
      kind: "sphere",
      radius: Math.min(...boxSize) / 2,
    };
  } else {
    shape = {
      center,
      kind: "box",
      size: boxSize,
    };
  }

  return {
    enabled: true,
    frame: "object",
    name,
    priority,
    realization_policy: "inherit",
    shape,
  };
}

export function findRegionIdByName(
  scene: SceneResource | null,
  objectId: string,
  regionName: string,
): string | null {
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;
  if (!object || !Array.isArray(object.regions)) return null;

  const targetName = regionName.trim();
  const matches = object.regions
    .map(asRecord)
    .filter((region) => asString(region?.name) === targetName);
  if (matches.length !== 1) return null;

  return asString(matches[0]?.region_id) ?? asString(matches[0]?.id);
}

export function findLastRegionSelection(
  scene: SceneResource | null,
  objectId: string,
  excludedRegionId: string,
): { name: string; regionId: string } | null {
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;
  if (!object || !Array.isArray(object.regions)) return null;

  const candidates = object.regions
    .map(asRecord)
    .filter((region): region is JsonRecord => {
      const regionId = asString(region?.region_id) ?? asString(region?.id);
      return Boolean(regionId && regionId !== excludedRegionId);
    });
  const last = candidates.at(-1);
  if (!last) return null;
  const regionId = asString(last.region_id) ?? asString(last.id);
  const name = asString(last.name);
  return regionId && name ? { name, regionId } : null;
}

export function regionNodeId(objectId: string, regionId: string): string {
  return `model:object:${objectId}:regions:${regionId}`;
}

export function regionsNodeId(objectId: string): string {
  return `model:object:${objectId}:regions`;
}
